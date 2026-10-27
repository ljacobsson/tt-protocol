import assert from "node:assert/strict";
import test from "node:test";

import {handleMcpRequest, matchName} from "../backend/mcp.js";

/* Behaves like app.js's store: saves are refused when another device saved
   in between or the tournament is finalized. */
function memoryStore({players = [], tournaments = []} = {}) {
  const club = {clubId: "secret", alias: "bbtk", name: "BBTK", savedNames: [], players, tournaments};
  let clock = 0;
  return {
    club,
    beforeSave: null,
    async loadClub() { return structuredClone(club); },
    async saveTournament(payload, tournamentId) {
      if (this.beforeSave) { const hook = this.beforeSave; this.beforeSave = null; hook(); }
      const index = club.tournaments.findIndex(t => t.tournamentId === tournamentId);
      const existing = club.tournaments[index];
      if (existing && (existing.status === "finalized" ||
          (payload.expectedUpdatedAt && payload.expectedUpdatedAt !== existing.updatedAt))) {
        const error = new Error("conflict");
        error.name = "ConditionalCheckFailedException";
        error.finalized = existing.status === "finalized";
        throw error;
      }
      const saved = {
        tournamentId: tournamentId || "t" + (club.tournaments.length + 1),
        name: payload.name, playedAt: payload.playedAt, type: payload.type, status: payload.status,
        state: structuredClone(payload.state), participants: payload.participants,
        matches: payload.matches, podium: payload.podium, updatedAt: String(++clock).padStart(6, "0"),
      };
      if (index >= 0) club.tournaments[index] = saved; else club.tournaments.push(saved);
      return structuredClone(saved);
    },
  };
}

let nextId = 1;
async function rpc(store, method, params) {
  const reply = await handleMcpRequest(
    {method: "POST", body: JSON.stringify({jsonrpc: "2.0", id: nextId++, method, params})},
    store, {appUrl: "https://app.example"});
  return reply.body;
}
async function call(store, name, args = {}) {
  const {result, error} = await rpc(store, "tools/call", {name, arguments: args});
  if (error) throw new Error(error.message);
  if (result.isError) throw new Error(result.content[0].text);
  return result.structuredContent;
}
const stored = store => store.club.tournaments.at(-1);

test("speaks the MCP handshake", async () => {
  const store = memoryStore();
  const init = await rpc(store, "initialize", {protocolVersion: "2025-03-26", capabilities: {}});
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.ok(init.result.capabilities.tools);
  const notification = await handleMcpRequest({method: "POST",
    body: JSON.stringify({jsonrpc: "2.0", method: "notifications/initialized"})}, store);
  assert.equal(notification.statusCode, 202);
  const {result} = await rpc(store, "tools/list", {});
  assert.ok(result.tools.some(tool => tool.name === "record_result"));
  assert.ok(result.tools.every(tool => tool.inputSchema.type === "object" && !tool.run));
  assert.equal((await handleMcpRequest({method: "GET"}, store)).statusCode, 405);
  assert.equal((await handleMcpRequest({method: "POST", body: "{"}, store)).body.error.code, -32700);
  assert.equal((await rpc(store, "nope", {})).error.code, -32601);
});

test("matches spoken names leniently but never guesses between players", () => {
  const players = [{name: "Anna Berg"}, {name: "Anders Ek"}, {name: "Björn Öst"}];
  assert.equal(matchName(players, "anna berg").match.name, "Anna Berg");
  assert.equal(matchName(players, "Anna").match.name, "Anna Berg");
  assert.equal(matchName(players, "bjorn").match.name, "Björn Öst");
  assert.equal(matchName(players, "Andres").match.name, "Anders Ek");
  assert.equal(matchName(players, "An").match, null);
  assert.equal(matchName(players, "Zlatan").match, null);
});

test("sets up, scores and finalizes a round robin", async () => {
  const store = memoryStore({players: [{playerId: "p-anna", name: "Anna", rating: 1100}]});
  const created = await call(store, "create_tournament", {
    name: "Tisdagspingis", playedAt: "2026-10-27", format: "bo5",
    players: ["anna", "Bo", "Cia", "Dan"], start: true,
  });
  assert.equal(created.tournament.status, "playing");
  assert.equal(created.tournament.url, "https://app.example/clubs/bbtk/tournaments/t1");
  assert.deepEqual(created.newClubPlayers.map(p => p.name), ["Bo", "Cia", "Dan"]);
  assert.equal(stored(store).state.players[0].name, "Anna", "club spelling is reused");
  assert.equal(stored(store).state.players[0].clubPlayerId, "p-anna");
  assert.equal(created.matches.length, 6);

  /* Anna has id 1 and Bo id 2, so the stored key is 1_2 in Anna's favour. */
  const saved = await call(store, "record_result", {player1: "Bo", player2: "Anna", score: "1-3"});
  assert.equal(saved.match.score, "3–1");
  assert.deepEqual(stored(store).state.results["1_2"], [3, 1]);
  assert.deepEqual(stored(store).state.rankingMatches["pool:1_2"], {
    matchId: "pool:1_2", winnerId: "p-anna", loserId: stored(store).state.players[1].clubPlayerId,
    ranked: true, setScore: [3, 1],
  });
  assert.equal(saved.standings.rows[0].name, "Anna");
  assert.deepEqual(stored(store).matches, Object.values(stored(store).state.rankingMatches));

  await assert.rejects(call(store, "record_result", {player1: "Cia", player2: "Dan", score: "2-2"}),
    /not a valid result for Bäst av 5/);
  await assert.rejects(call(store, "record_result", {player1: "Cia", player2: "Cia", score: "3-0"}),
    /against themselves/);

  await assert.rejects(call(store, "finalize_tournament"), /5 match\(es\) have no final result/);
  for (const [a, b] of [["Anna", "Cia"], ["Anna", "Dan"], ["Bo", "Cia"], ["Bo", "Dan"], ["Cia", "Dan"]])
    await call(store, "record_result", {player1: a, player2: b, score: "3-0"});
  const view = await call(store, "get_tournament", {matches: "open"});
  assert.equal(view.openMatches, 0);
  assert.deepEqual(view.podium, [{place: 1, names: ["Anna"]}, {place: 2, names: ["Bo"]}, {place: 3, names: ["Cia"]}]);

  const finalized = await call(store, "finalize_tournament");
  assert.equal(finalized.tournament.status, "finalized");
  assert.equal(stored(store).status, "finalized");
  assert.deepEqual(stored(store).podium, view.podium);
  await assert.rejects(call(store, "record_result",
    {tournament: "Tisdagspingis", player1: "Anna", player2: "Bo", score: "0-3"}), /finalized/);
});

test("ball points are validated and may be saved set by set", async () => {
  const store = memoryStore();
  await call(store, "create_tournament", {
    name: "Poäng", format: "bo3", scoring: "points", players: ["Anna", "Bo"], start: true,
  });
  const partial = await call(store, "record_result", {player1: "Anna", player2: "Bo", points: "11-7"});
  assert.equal(partial.match.status, "in-progress");
  await assert.rejects(call(store, "record_result", {player1: "Anna", player2: "Bo", points: "11-10"}),
    /Invalid set score/);
  await assert.rejects(call(store, "record_result",
    {player1: "Anna", player2: "Bo", points: "11-7, 11-5, 11-3"}), /already over after set 2/);
  await assert.rejects(call(store, "record_result",
    {player1: "Anna", player2: "Bo", score: "2-0", points: "11-7, 9-11, 11-3"}), /add up to 2–1/);
  const done = await call(store, "record_result",
    {player1: "Bo", player2: "Anna", points: "7-11, 13-11, 9-11"});
  assert.equal(done.match.score, "2–1 (11–7, 11–13, 11–9)");
  assert.deepEqual(stored(store).state.results["1_2"], [[11, 7], [11, 13], [11, 9]]);
});

test("pools seed by ranking and feed placement matches", async () => {
  const ratings = {Anna: 1400, Bo: 1300, Cia: 1200, Dan: 1100, Eva: 1000, Finn: 900, Gun: 800, Hugo: 700};
  const store = memoryStore({players: Object.entries(ratings)
    .map(([name, rating]) => ({playerId: "p-" + name, name, rating}))});
  const created = await call(store, "create_tournament", {
    name: "Pooler", format: "sets1", finals: "place",
    players: ["Hugo", "Gun", "Finn", "Eva", "Dan", "Cia", "Bo", "Anna"],
  });
  assert.equal(created.settings.pools, 2);
  const pools = Object.fromEntries(created.players.map(p => [p.name, p.pool]));
  assert.deepEqual(pools, {Anna: "A", Bo: "B", Cia: "B", Dan: "A", Eva: "A", Finn: "B", Gun: "B", Hugo: "A"});

  await assert.rejects(call(store, "record_result", {player1: "Anna", player2: "Dan", score: "1-0"}),
    /not been started/);
  await call(store, "start_tournament");
  const order = {A: ["Anna", "Dan", "Eva", "Hugo"], B: ["Bo", "Cia", "Finn", "Gun"]};
  for (const names of Object.values(order))
    for (let i = 0; i < names.length; i++)
      for (let j = i + 1; j < names.length; j++)
        await call(store, "record_result", {player1: names[i], player2: names[j], score: "1-0"});

  const view = await call(store, "get_tournament", {matches: "open"});
  assert.deepEqual(view.matches.map(m => [m.label, m.players.join(" – ")]), [
    ["Plats 1–2", "Anna – Bo"], ["Plats 3–4", "Dan – Cia"],
    ["Plats 5–6", "Eva – Finn"], ["Plats 7–8", "Hugo – Gun"],
  ]);
  await call(store, "record_result", {player1: "Bo", player2: "Anna", score: "1-0"});
  await call(store, "record_result", {player1: "Cia", player2: "Dan", score: "0-1"});
  const {podium} = await call(store, "finalize_tournament", {allowUnfinished: true});
  assert.deepEqual(podium, [
    {place: 1, names: ["Bo"]}, {place: 2, names: ["Anna"]}, {place: 3, names: ["Dan"]},
  ]);
});

test("A/B playoffs wait for the pools and need a winner", async () => {
  const store = memoryStore();
  await call(store, "create_tournament", {
    name: "Cup", format: "sets2", pools: 2, finals: "ab", advance: "1", useSeeding: false,
    players: ["Anna", "Bo", "Cia", "Dan"], start: true,
  });
  const before = await call(store, "get_tournament");
  const final = before.matches.find(m => m.label === "A-slutspel final");
  assert.equal(final.status, "waiting");
  assert.deepEqual(final.players, ["A1", "B1"]);
  await assert.rejects(call(store, "record_result", {matchId: final.matchId, score: "2-0"}),
    /cannot be played until/);

  /* Snake order without seeding: Anna A, Bo B, Cia B, Dan A. */
  await call(store, "record_result", {player1: "Anna", player2: "Dan", score: "2-0"});
  await call(store, "record_result", {player1: "Bo", player2: "Cia", score: "1-1"});
  const ready = await call(store, "get_tournament", {matches: "open"});
  assert.deepEqual(ready.matches[0].players, ["Anna", "Bo"]);
  await assert.rejects(call(store, "record_result", {player1: "Anna", player2: "Bo", score: "2-2"}),
    /in a playoff/);
  const saved = await call(store, "record_result", {player1: "Bo", player2: "Anna", score: "2-1"});
  assert.equal(saved.match.score, "1–2");
  assert.equal(stored(store).state.rankingMatches["final:a0_0"].winnerId,
    stored(store).state.players.find(p => p.name === "Bo").clubPlayerId);
});

test("Davis Cup: doubles by team, singles ranked, rest skipped once decided", async () => {
  const store = memoryStore();
  await call(store, "create_tournament", {
    name: "Davis", gameMode: "davis-cup", players: ["Anna", "Bo", "Xia", "Yan"], start: true,
  });
  await assert.rejects(call(store, "update_tournament", {addPlayers: ["Eva"]}), /reopen_setup/);
  await call(store, "record_result", {player1: "Xia", player2: "Anna", score: "0-3"});
  await call(store, "record_result", {player1: "Bo", player2: "Yan", score: "3-2"});
  const doubles = await call(store, "record_result", {doubles: true, player1: "Yan", score: "1-3"});
  assert.equal(doubles.match.score, "3–1");
  assert.equal(doubles.davisCup.score, "3–0");
  assert.equal(doubles.davisCup.winner, "Anna & Bo");
  assert.equal(stored(store).state.rankingMatches["final:davis:3"], undefined);
  assert.equal(Object.keys(stored(store).state.rankingMatches).length, 2);
  await assert.rejects(call(store, "record_result", {player1: "Anna", player2: "Yan", score: "3-0"}),
    /already decided/);
  const finalized = await call(store, "finalize_tournament");
  assert.deepEqual(finalized.podium, [{place: 1, names: ["Anna", "Bo"]}, {place: 2, names: ["Xia", "Yan"]}]);
});

test("winner stays rotates the loser out and ranks all three", async () => {
  const store = memoryStore();
  await call(store, "create_tournament", {
    name: "Kvar", gameMode: "winner-stays", winnerStaysTarget: 2, players: ["Anna", "Bo", "Cia"], start: true,
  });
  await assert.rejects(call(store, "record_winner_stays_set", {winner: "Cia"}), /Only Anna and Bo/);
  let game = (await call(store, "record_winner_stays_set", {winner: "Anna"})).winnerStays;
  assert.deepEqual(game.nowPlaying, ["Anna", "Cia"]);
  game = (await call(store, "record_winner_stays_set", {winner: "Cia"})).winnerStays;
  assert.deepEqual(game.nowPlaying, ["Cia", "Bo"]);
  game = (await call(store, "record_winner_stays_set", {winner: "Cia"})).winnerStays;
  assert.equal(game.finished, true);
  const view = await call(store, "get_tournament");
  assert.deepEqual(view.podium.map(group => group.names[0]), ["Cia", "Anna", "Bo"]);
  assert.equal(stored(store).state.rankingMatches["winner-stays"].rankingMode, "winner-stays");
});

test("setup changes that wipe results need confirmation", async () => {
  const store = memoryStore();
  await call(store, "create_tournament", {name: "Ändra", players: ["Anna", "Bo", "Cia"], start: true});
  await call(store, "record_result", {player1: "Anna", player2: "Bo", score: "2-0"});
  await call(store, "reopen_setup");
  assert.deepEqual(stored(store).state.results, {"1_2": [2, 0]});
  await assert.rejects(call(store, "update_tournament", {format: "bo3"}), /clearResults: true/);
  const renamed = await call(store, "update_tournament", {name: "Ändrad", removePlayers: ["Cia"]});
  assert.equal(renamed.tournament.name, "Ändrad");
  assert.deepEqual(renamed.players.map(p => p.name), ["Anna", "Bo"]);
  const changed = await call(store, "update_tournament", {format: "bo3", clearResults: true});
  assert.equal(changed.settings.format, "bo3");
  assert.deepEqual(stored(store).state.results, {});
});

test("a save racing another device is retried on the fresh copy", async () => {
  const store = memoryStore();
  await call(store, "create_tournament", {name: "Race", players: ["Anna", "Bo", "Cia"], start: true});
  store.beforeSave = () => {
    const tournament = store.club.tournaments[0];
    tournament.state.results["2_3"] = [0, 2];
    tournament.updatedAt = "other-device";
  };
  await call(store, "record_result", {player1: "Anna", player2: "Bo", score: "2-0"});
  assert.deepEqual(stored(store).state.results, {"1_2": [2, 0], "2_3": [0, 2]});
});

test("defaults to the latest unfinished tournament and resolves names", async () => {
  const store = memoryStore();
  await call(store, "create_tournament", {name: "Måndag", players: ["Anna", "Bo"], start: true});
  await call(store, "create_tournament", {name: "Tisdag", players: ["Cia", "Dan"], start: true});
  await call(store, "record_result", {player1: "Cia", player2: "Dan", score: "2-0"});
  await assert.rejects(call(store, "record_result", {player1: "Anna", player2: "Bo", score: "2-0"}),
    /No player called "Anna"/);
  await call(store, "record_result", {tournament: "måndag", player1: "Anna", player2: "Bo", score: "2-0"});
  const list = await call(store, "list_tournaments");
  assert.deepEqual(list.tournaments.map(t => t.name).sort(), ["Måndag", "Tisdag"]);
});
