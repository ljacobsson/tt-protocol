/*
 * Model Context Protocol endpoint, so an assistant such as ChatGPT can set up
 * and score a club's tournaments by voice or text. It speaks stateless
 * Streamable HTTP: every JSON-RPC request is answered with a plain JSON
 * response, so it runs in the same Lambda as the REST API. The club secret in
 * the endpoint URL is the access, like the club link in the browser.
 *
 * Storage is injected (see app.js), so the tools can be tested without
 * DynamoDB. Every change is a fresh read, the edit and a conditional save, so
 * a board that is open on another device is never overwritten blindly.
 */
import * as board from "./tournament.js";

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = {name: "matchprotokoll", title: "Matchprotokoll by Pingis.net", version: "1.0.0"};
const SAVE_ATTEMPTS = 4;

const INSTRUCTIONS = `Matchprotokoll keeps score for one table tennis club's tournaments.
Game modes: "pool" (round robin in one or more pools, optionally followed by placement matches or A/B playoff brackets), "winner-stays" (exactly 3 players, first to N sets) and "davis-cup" (2 vs 2 players, five matches).
Typical flow: create_tournament with the players -> start_tournament -> record_result for each match -> finalize_tournament once the user confirms.
Tools default to the club's most recently changed unfinished tournament; pass "tournament" (id or name) to pick another.
Players can be named the way the user says them; names are matched case-insensitively and tolerate small misspellings. If a tool reports an ambiguous or unknown name, ask the user instead of guessing.
Scores are always from player1's point of view: "Anna beat Bo 3-1" is player1 Anna, player2 Bo, score "3-1"; "Bo lost 1-3 to Anna" is the same result. Use get_tournament to see which matches are open and how to name them.
Finalizing updates the club ranking and cannot be undone, so always ask for confirmation first.
The app and its player names are Swedish; answer in the user's language.`;

/* ---- Small helpers ---------------------------------------------------- */

const fail = message => { throw new board.RuleError(message); };

const fold = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/* Edit distance where swapping two neighbouring letters counts once. */
function editDistance(a, b) {
  const d = Array.from({length: a.length + 1}, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1,
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/*
 * Finds the candidate a spoken or typed name refers to: an exact match, then
 * a unique first name or prefix, then a unique close spelling.
 */
export function matchName(candidates, spoken, nameOf = candidate => candidate.name) {
  const wanted = fold(spoken);
  if (!wanted) return {match: null, options: []};
  const named = candidates.map(candidate => ({candidate, folded: fold(nameOf(candidate))}));
  const exact = named.filter(entry => entry.folded === wanted);
  if (exact.length === 1) return {match: exact[0].candidate, options: []};
  const partial = named.filter(entry =>
    entry.folded.startsWith(wanted + " ") || entry.folded.split(" ").includes(wanted) ||
    (wanted.length >= 3 && entry.folded.startsWith(wanted)));
  if (partial.length === 1) return {match: partial[0].candidate, options: []};
  if (partial.length > 1) return {match: null, options: partial.map(entry => entry.candidate)};
  const limit = Math.max(1, Math.floor(wanted.length / 4));
  const close = named
    .map(entry => ({...entry, distance: Math.min(editDistance(entry.folded, wanted),
      ...entry.folded.split(" ").map(part => editDistance(part, wanted)))}))
    .filter(entry => entry.distance <= limit)
    .sort((a, b) => a.distance - b.distance);
  if (close.length === 1 || (close.length > 1 && close[0].distance < close[1].distance))
    return {match: close[0].candidate, options: []};
  return {match: null, options: close.map(entry => entry.candidate)};
}

function findPlayer(state, spoken) {
  const {match, options} = matchName(state.players, spoken);
  if (match) return match;
  const names = (options.length ? options : state.players).map(player => player.name);
  return fail(options.length
    ? `"${spoken}" could mean ${names.join(" or ")}. Which one?`
    : `No player called "${spoken}" in this tournament. Players: ${names.join(", ") || "none"}.`);
}

/* "3-1", "3–1", "3:1" and "3 1" are all a pair. */
function parsePairs(value) {
  const parts = Array.isArray(value) ? value : [value];
  const pairs = [];
  for (const part of parts) {
    if (Array.isArray(part)) { pairs.push(part.map(Number)); continue; }
    const text = String(part ?? "");
    const found = [...text.matchAll(/(\d{1,3})\s*(?:-|–|—|:|\s)\s*(\d{1,3})/g)];
    if (!found.length && text.trim()) fail(`Could not read "${text}" as a score like 3-1.`);
    found.forEach(m => pairs.push([Number(m[1]), Number(m[2])]));
  }
  return pairs;
}

const scoreText = result => {
  const sets = board.setsOf(result);
  if (!sets) return null;
  const points = Array.isArray(result[0]) ? " (" + result.map(set => set.join("–")).join(", ") + ")" : "";
  return sets.join("–") + points;
};

const placeName = pool => board.poolName(Number(pool) || 0);

/* ---- Reading the club ------------------------------------------------- */

const recent = tournaments => tournaments.slice().sort((a, b) =>
  String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));

function pickTournament(club, reference) {
  const tournaments = recent(club.tournaments);
  if (!reference) {
    const draft = tournaments.find(tournament => tournament.status !== "finalized");
    return draft || fail("The club has no unfinished tournament. Create one with create_tournament " +
      "or name a finished one.");
  }
  const byId = tournaments.find(tournament => tournament.tournamentId === reference);
  if (byId) return byId;
  /* Recurring club nights share a name; the latest unfinished one is meant. */
  const sameName = tournaments.filter(tournament => fold(tournament.name) === fold(reference));
  if (sameName.length > 1)
    return sameName.find(tournament => tournament.status !== "finalized") || sameName[0];
  const {match, options} = matchName(tournaments, reference);
  if (match) return match;
  return fail(options.length
    ? `"${reference}" could mean ${options.map(t => `${t.name} (${t.playedAt})`).join(" or ")}.`
    : `No tournament called "${reference}".`);
}

function clubContext(club) {
  const players = club.players || [];
  const ratingOf = player => {
    const ranked = players.find(candidate =>
      candidate.playerId === player.clubPlayerId || board.norm(candidate.name) === board.norm(player.name));
    return ranked && Number.isFinite(Number(ranked.rating)) ? Number(ranked.rating) : 1000;
  };
  const clubPlayerFor = name => {
    const ranked = players.find(candidate => board.norm(candidate.name) === board.norm(name));
    if (ranked) return ranked;
    const saved = (club.savedNames || []).find(saved => board.norm(saved) === board.norm(name));
    return saved ? {name: saved} : null;
  };
  /* Club players a new, unknown name was perhaps meant to be. */
  const similar = name => {
    const {options, match} = matchName(players, name);
    return (match ? [match] : options).slice(0, 3).map(player => player.name);
  };
  return {ratingOf, clubPlayerFor, similar};
}

function tournamentUrl(club, tournament, appUrl) {
  if (!tournament.tournamentId || !appUrl) return undefined;
  return appUrl.replace(/\/$/, "") + "/clubs/" + encodeURIComponent(club.alias || club.clubId) +
    "/tournaments/" + encodeURIComponent(tournament.tournamentId);
}

/* ---- Describing a tournament ------------------------------------------ */

function describeMatch(match) {
  return {
    matchId: match.matchId,
    label: match.label,
    players: match.sides,
    status: match.status,
    score: scoreText(match.result) || undefined,
  };
}

function standings(state) {
  if (state.gameMode !== "pool") return undefined;
  return Array.from({length: state.pools}, (_, pool) => {
    const players = state.pools > 1 ? board.poolMembers(state, pool) : state.players;
    return {
      pool: state.pools > 1 ? board.poolName(pool) : undefined,
      complete: board.poolComplete(state, pool),
      rows: board.computeStandings(state, players).map((row, index) => ({
        place: index + 1, name: row.p.name, played: row.m, won: row.w, drawn: row.d, lost: row.l,
        sets: row.sf + "–" + row.sa, points: row.pts,
      })),
    };
  });
}

function gameStatus(state) {
  if (state.gameMode === "davis-cup" && state.players.length >= 4) {
    const status = board.davisCupStatus(state);
    const teams = board.davisCupTeams(state).map(team => team.map(p => p.name).join(" & "));
    return {davisCup: {
      teams, score: status.wins.join("–"), over: status.over,
      winner: status.winner === null ? (status.over ? "draw" : null) : teams[status.winner],
      playAllMatches: !!state.davisCup?.playAll,
    }};
  }
  if (state.gameMode === "winner-stays" && state.winnerStays) {
    const game = state.winnerStays;
    const name = id => board.byId(state, id)?.name;
    const scores = board.winnerStaysScores(state);
    return {winnerStays: {
      firstTo: state.winnerStaysTarget,
      setsWon: Object.fromEntries(state.players.map(p => [p.name, scores[p.id]])),
      finished: !!game.runnerUp,
      nowPlaying: game.runnerUp ? undefined : game.current.map(name),
      resting: game.runnerUp || game.tiebreak ? undefined : name(game.resting),
      tiebreakForSecond: !!game.tiebreak,
      setsPlayed: game.sets.length,
    }};
  }
  return {};
}

function describeTournament(club, tournament, state, {appUrl, matches = "all"} = {}) {
  const all = board.listMatches(state);
  const shown = matches === "open"
    ? all.filter(match => match.status === "open" || match.status === "in-progress")
    : all;
  const settings = {
    gameMode: state.gameMode,
    format: state.format,
    formatLabel: board.FORMATS[state.format]?.label,
    scoring: state.scoring,
  };
  if (state.gameMode === "pool") Object.assign(settings, {
    pools: state.pools, finals: state.finals,
    advance: state.finals === "ab" ? state.advance : undefined,
    useSeeding: state.useSeeding !== false,
  });
  if (state.gameMode === "winner-stays") settings.winnerStaysTarget = state.winnerStaysTarget;
  if (state.gameMode === "davis-cup") settings.davisCupPlayAll = !!state.davisCup?.playAll;
  const ctx = clubContext(club);
  const finished = all.length > 0 && all.every(match => match.status === "done" || match.status === "skipped");
  return {
    tournament: {
      id: tournament.tournamentId,
      name: tournament.name,
      playedAt: tournament.playedAt,
      championship: tournament.type === "championship",
      status: tournament.status === "finalized" ? "finalized" : state.phase === "play" ? "playing" : "setup",
      url: tournamentUrl(club, tournament, appUrl),
    },
    settings,
    players: state.players.map((player, index) => ({
      name: player.name,
      pool: state.gameMode === "pool" && state.pools > 1 ? placeName(player.pool) : undefined,
      team: state.gameMode === "davis-cup" && index < 4 ? (index < 2 ? 1 : 2) : undefined,
      rating: ctx.ratingOf(player),
    })),
    standings: state.phase === "play" ? standings(state) : undefined,
    ...gameStatus(state),
    matches: state.phase === "play" ? shown.map(describeMatch) : undefined,
    openMatches: state.phase === "play"
      ? all.filter(match => match.status === "open" || match.status === "in-progress").length
      : undefined,
    startProblem: state.phase === "setup" ? board.startProblem(state) || undefined : undefined,
    podium: tournament.status === "finalized" ? tournament.podium
      : finished || (state.gameMode === "winner-stays" && state.winnerStays?.runnerUp)
        ? board.podium(state) : undefined,
  };
}

/* ---- Changing a tournament -------------------------------------------- */

/*
 * Runs edit on a fresh copy of the board and saves it. A save that loses a
 * race with another device is retried on the new server copy.
 */
async function change(store, reference, edit) {
  for (let attempt = 1; ; attempt++) {
    const club = await store.loadClub();
    const tournament = structuredClone(pickTournament(club, reference));
    if (tournament.status === "finalized")
      fail(`"${tournament.name}" is finalized and can no longer be changed.`);
    const state = board.loadState(tournament.state);
    const ctx = clubContext(club);
    const outcome = edit(state, tournament, ctx);
    try {
      const saved = await store.saveTournament(
        board.tournamentPayload(tournament, state), tournament.tournamentId);
      return {club, tournament: saved, state: board.loadState(saved.state), outcome};
    } catch (error) {
      if (error.name !== "ConditionalCheckFailedException") throw error;
      if (error.finalized) fail(`"${tournament.name}" was just finalized on another device.`);
      if (attempt >= SAVE_ATTEMPTS) fail("The tournament keeps changing on another device. Try again.");
    }
  }
}

function findMatch(state, args) {
  const matches = board.listMatches(state);
  if (args.matchId) {
    return matches.find(match => match.matchId === args.matchId) ||
      fail(`No match ${args.matchId}. Use get_tournament to list the matches.`);
  }
  if (!args.player1 || (!args.player2 && !args.doubles))
    fail("Name both players (player1 and player2), or pass matchId.");
  const first = findPlayer(state, args.player1);
  const second = args.player2 ? findPlayer(state, args.player2) : null;
  if (second && first.id === second.id) fail(`${first.name} cannot play against themselves.`);
  const sideOf = (match, player) => match.doubles
    ? match.teams.findIndex(team => team.includes(player.id))
    : (match.playerIds || []).indexOf(player.id);
  let candidates = matches.filter(match => {
    if (!!args.doubles !== !!match.doubles) return false;
    const a = sideOf(match, first);
    return a >= 0 && (!second || sideOf(match, second) === 1 - a);
  });
  if (candidates.length > 1) {
    const live = candidates.filter(match => match.status === "open" || match.status === "in-progress");
    if (live.length) candidates = live;
  }
  if (!candidates.length) {
    const waiting = matches.find(match => match.status === "waiting");
    fail(`There is no playable match between ${first.name}${second ? " and " + second.name : ""}.` +
      (state.phase !== "play" ? " The tournament has not been started." : "") +
      (waiting ? " Some playoff matches are still waiting for earlier results." : "") +
      (state.gameMode === "davis-cup" && !args.doubles ? " For the doubles, set doubles: true." : ""));
  }
  if (candidates.length > 1) {
    fail(`${first.name} and ${second.name} meet more than once. Pass one of these matchIds: ` +
      candidates.map(match => `${match.matchId} (${match.label}, ${match.status})`).join("; ") + ".");
  }
  const match = candidates[0];
  return {...match, flip: sideOf(match, first) === 1};
}

function resultFrom(args) {
  const points = args.points ? parsePairs(args.points) : [];
  const sets = args.score !== undefined && args.score !== "" ? parsePairs(args.score) : [];
  if (sets.length > 1) fail(`Give the match score as one pair like 3-1, or the sets in points.`);
  if (!points.length && !sets.length) fail("Give the result as score (sets, e.g. 3-1) or points (e.g. 11-7, 8-11, 11-9).");
  if (points.length && sets.length) {
    const fromPoints = board.setsOf(points);
    if (fromPoints[0] !== sets[0][0] || fromPoints[1] !== sets[0][1])
      fail(`The set scores add up to ${fromPoints.join("–")}, not ${sets[0].join("–")}.`);
  }
  return points.length ? points : sets[0];
}

/* ---- Tools ------------------------------------------------------------ */

const tournamentArg = {
  type: "string",
  description: "Tournament id or name. Omit to use the club's most recently changed unfinished tournament.",
};
const playerArgs = {
  player1: {type: "string", description: "First player as the user said it. The score is from this player's point of view."},
  player2: {type: "string", description: "The opponent."},
  doubles: {type: "boolean", description: "Davis Cup only: the doubles match. player1 may be anyone on the first-named team; player2 can be omitted."},
  matchId: {type: "string", description: "Exact match id from get_tournament, instead of naming the players."},
};
const settingsArgs = {
  gameMode: {type: "string", enum: board.GAME_MODES, description: "pool (round robin), winner-stays (exactly 3 players) or davis-cup (exactly 4: players 1–2 are team 1, 3–4 team 2)."},
  format: {type: "string", enum: Object.keys(board.FORMATS), description: "sets1 = 1 set, sets2 = 2 sets (1–1 draw allowed in pools), bo3/bo5/bo7 = best of 3/5/7."},
  scoring: {type: "string", enum: board.SCORING, description: "sets = only the set score is entered; points = ball points per set."},
  pools: {type: "integer", minimum: 1, description: "Number of pools. Omit to use the app's recommendation (about 4 players per pool)."},
  finals: {type: "string", enum: board.FINALS, description: "After the pools: none, place (placement matches, exactly 2 pools) or ab (A and B playoff brackets)."},
  advance: {type: "string", enum: ["1", "2", "3", "half"], description: 'With finals "ab": how many per pool go to the A bracket, or "half" for the top half of the field.'},
  useSeeding: {type: "boolean", description: "Spread players over the pools by club ranking (default true)."},
  winnerStaysTarget: {type: "integer", minimum: 1, maximum: 8, description: "Winner stays: sets needed to win (default 5)."},
  davisCupPlayAll: {type: "boolean", description: "Davis Cup: play all five matches even when the meeting is already decided."},
};

/* Pool count, seeding and playoffs depend on the players, so they go last. */
const LATE_SETTINGS = ["pools", "useSeeding", "finals", "advance", "clearResults"];
const earlySettings = args => Object.fromEntries(Object.entries(args)
  .filter(([key]) => !LATE_SETTINGS.includes(key) || key === "clearResults"));
const lateSettings = args => Object.fromEntries(Object.entries(args)
  .filter(([key]) => LATE_SETTINGS.includes(key)));

const read = {readOnlyHint: true, openWorldHint: false};
const write = {readOnlyHint: false, destructiveHint: false, openWorldHint: false};
const destructive = {readOnlyHint: false, destructiveHint: true, openWorldHint: false};

export const TOOLS = [
  {
    name: "list_tournaments",
    title: "List tournaments and club ranking",
    description: "The club's tournaments (newest first) and its players in ranking order.",
    inputSchema: {type: "object", properties: {
      rankingLimit: {type: "integer", minimum: 0, description: "How many ranked players to include (default 20)."},
    }},
    annotations: read,
    async run(store, args, options) {
      const club = await store.loadClub();
      const limit = args.rankingLimit ?? 20;
      return {
        club: club.name,
        tournaments: recent(club.tournaments).map(tournament => ({
          id: tournament.tournamentId,
          name: tournament.name,
          playedAt: tournament.playedAt,
          status: tournament.status === "finalized" ? "finalized"
            : tournament.state?.phase === "play" ? "playing" : "setup",
          players: (tournament.participants || []).length,
          podium: tournament.podium,
          url: tournamentUrl(club, tournament, options.appUrl),
        })),
        ranking: (club.players || []).slice()
          .sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name, "sv"))
          .slice(0, limit)
          .map((player, index) => ({rank: index + 1, name: player.name, rating: player.rating})),
      };
    },
  },
  {
    name: "get_tournament",
    title: "Show tournament",
    description: "Settings, players, pool standings, Davis Cup or winner-stays status, and every match with its id, players and score. Match status: open, in-progress (some sets entered), done, waiting (playoff players not decided yet) or skipped.",
    inputSchema: {type: "object", properties: {
      tournament: tournamentArg,
      matches: {type: "string", enum: ["all", "open"], description: "List all matches (default) or only those still to be played."},
    }},
    annotations: read,
    async run(store, args, options) {
      const club = await store.loadClub();
      const tournament = pickTournament(club, args.tournament);
      return describeTournament(club, tournament, board.loadState(tournament.state),
        {appUrl: options.appUrl, matches: args.matches});
    },
  },
  {
    name: "create_tournament",
    title: "Create tournament",
    description: "Creates a new tournament for the club, optionally with players and settings, and optionally starts it right away. Unknown names become new club players, so check spelling against the club ranking first when unsure.",
    inputSchema: {type: "object", required: ["name"], properties: {
      name: {type: "string", description: "Tournament name, e.g. \"Klubbmästerskap 2026\"."},
      playedAt: {type: "string", description: "Date played, YYYY-MM-DD. Defaults to today."},
      championship: {type: "boolean", description: "Club/district/national championship: ranking points count 1.5x."},
      players: {type: "array", items: {type: "string"}, description: "Player names, in the order given (matters for Davis Cup teams)."},
      ...settingsArgs,
      start: {type: "boolean", description: "Start play immediately after setup."},
    }},
    annotations: write,
    async run(store, args, options) {
      const club = await store.loadClub();
      const ctx = clubContext(club);
      const name = String(args.name || "").trim().slice(0, 80) || fail("The tournament needs a name.");
      const playedAt = args.playedAt || new Date().toISOString().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(playedAt)) fail("playedAt must be YYYY-MM-DD.");
      const state = board.blankState();
      board.applySettings(state, earlySettings(args), ctx);
      const added = (args.players || []).map(playerName => addPlayer(state, playerName, ctx));
      board.normalizeSetup(state, ctx.ratingOf);
      board.applySettings(state, lateSettings(args), ctx);
      if (args.start) board.start(state);
      const meta = {name, playedAt, type: args.championship ? "championship" : "normal", status: "draft"};
      const saved = await store.saveTournament(board.tournamentPayload(meta, state));
      return {
        created: true,
        newClubPlayers: newClubPlayers(added),
        ...describeTournament(club, saved, board.loadState(saved.state), {appUrl: options.appUrl, matches: "open"}),
      };
    },
  },
  {
    name: "update_tournament",
    title: "Change tournament setup",
    description: "Renames or re-dates a tournament, or, before it has started (or after reopen_setup), adds/removes/moves players and changes settings. Changing game mode, format or scoring clears entered results and needs clearResults: true.",
    inputSchema: {type: "object", properties: {
      tournament: tournamentArg,
      name: {type: "string"},
      playedAt: {type: "string", description: "YYYY-MM-DD"},
      championship: {type: "boolean"},
      addPlayers: {type: "array", items: {type: "string"}},
      removePlayers: {type: "array", items: {type: "string"}},
      movePlayers: {type: "array", description: "Move players to another pool.", items: {
        type: "object", required: ["player", "pool"],
        properties: {player: {type: "string"}, pool: {type: "string", description: "Pool letter, e.g. B."}},
      }},
      davisCupLineup: {type: "array", items: {type: "string"}, description: "All four Davis Cup players in order: team 1 player A, B, then team 2 player X, Y."},
      ...settingsArgs,
      clearResults: {type: "boolean", description: "Confirms that the change may clear results already entered."},
    }},
    annotations: write,
    async run(store, args, options) {
      const setupKeys = ["addPlayers", "removePlayers", "movePlayers", "davisCupLineup", ...Object.keys(settingsArgs)];
      const changesSetup = setupKeys.some(key => args[key] !== undefined);
      const {club, tournament, state, outcome} = await change(store, args.tournament, (state, tournament, ctx) => {
        if (args.name !== undefined) tournament.name = String(args.name).trim().slice(0, 80) || fail("The name cannot be empty.");
        if (args.playedAt !== undefined) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(args.playedAt)) fail("playedAt must be YYYY-MM-DD.");
          tournament.playedAt = args.playedAt;
        }
        if (args.championship !== undefined) tournament.type = args.championship ? "championship" : "normal";
        if (!changesSetup) return {};
        if (state.phase !== "setup")
          fail("The tournament is being played. Call reopen_setup first (results are kept), then change the setup.");
        board.applySettings(state, earlySettings(args), ctx);
        for (const spoken of args.removePlayers || []) board.removePlayer(state, findPlayer(state, spoken), ctx);
        const added = (args.addPlayers || []).map(spoken => addPlayer(state, spoken, ctx));
        board.normalizeSetup(state, ctx.ratingOf);
        board.applySettings(state, lateSettings(args), ctx);
        for (const move of args.movePlayers || []) {
          const player = findPlayer(state, move.player);
          const pool = String(move.pool || "").trim().toUpperCase().replace(/^POOL\s*/, "");
          const index = Array.from({length: state.pools}, (_, i) => board.poolName(i)).indexOf(pool);
          if (index < 0) fail(`There is no pool ${move.pool}; the tournament has ${state.pools} pool(s).`);
          player.pool = index;
        }
        if (args.davisCupLineup) {
          if (state.gameMode !== "davis-cup") fail("davisCupLineup is only for Davis Cup.");
          const lineup = args.davisCupLineup.map(spoken => findPlayer(state, spoken));
          if (lineup.length !== state.players.length || new Set(lineup.map(p => p.id)).size !== lineup.length)
            fail("List every Davis Cup player exactly once.");
          if (lineup.some((player, index) => player !== state.players[index])) {
            if (Object.keys(state.fresults).length && !args.clearResults)
              fail("A new lineup clears the Davis Cup results. Ask the user, then retry with clearResults: true.");
            state.players = lineup;
            state.fresults = {};
            state.rankingMatches = {};
          }
        }
        return {added};
      });
      return {
        updated: true,
        newClubPlayers: newClubPlayers(outcome.added || []),
        ...describeTournament(club, tournament, state, {appUrl: options.appUrl, matches: "open"}),
      };
    },
  },
  {
    name: "start_tournament",
    title: "Start tournament",
    description: "Ends setup and starts play, so results can be entered.",
    inputSchema: {type: "object", properties: {tournament: tournamentArg}},
    annotations: write,
    async run(store, args, options) {
      const {club, tournament, state} = await change(store, args.tournament, (state, _tournament, ctx) => {
        if (state.phase === "play") fail("The tournament is already being played.");
        board.normalizeSetup(state, ctx.ratingOf);
        board.start(state);
      });
      return {started: true, ...describeTournament(club, tournament, state, {appUrl: options.appUrl, matches: "open"})};
    },
  },
  {
    name: "reopen_setup",
    title: "Back to setup",
    description: "Returns a started tournament to setup so players or settings can be changed. Entered results are kept.",
    inputSchema: {type: "object", properties: {tournament: tournamentArg}},
    annotations: write,
    async run(store, args, options) {
      const {club, tournament, state} = await change(store, args.tournament, state => {
        if (state.phase === "setup") fail("The tournament is already in setup.");
        state.phase = "setup";
      });
      return {reopened: true, ...describeTournament(club, tournament, state, {appUrl: options.appUrl})};
    },
  },
  {
    name: "record_result",
    title: "Record match result",
    description: "Enters or corrects the result of a pool, playoff or Davis Cup match. Give the set score (\"3-1\") and/or the ball points of each set (\"11-7, 8-11, 11-9, 11-5\"), both from player1's point of view. With ball points, a match in progress may be saved after each set.",
    inputSchema: {type: "object", properties: {
      tournament: tournamentArg,
      ...playerArgs,
      score: {type: "string", description: "Sets won, player1 first, e.g. \"3-1\"."},
      points: {type: "string", description: "Ball points per set, player1 first, e.g. \"11-7, 8-11, 11-9\"."},
    }},
    annotations: write,
    async run(store, args, options) {
      const {club, tournament, state, outcome} = await change(store, args.tournament, state => {
        const match = findMatch(state, args);
        const result = resultFrom(args);
        board.recordResult(state, match, match.flip ? board.flipResult(result) : result);
        return {matchId: match.matchId};
      });
      return afterResult(club, tournament, state, outcome.matchId, options);
    },
  },
  {
    name: "clear_result",
    title: "Clear match result",
    description: "Removes the entered result of a match, so it counts as not played.",
    inputSchema: {type: "object", properties: {tournament: tournamentArg, ...playerArgs}},
    annotations: destructive,
    async run(store, args, options) {
      const {club, tournament, state, outcome} = await change(store, args.tournament, state => {
        const match = findMatch(state, args);
        if (!match.result) fail(`${match.label} has no result to clear.`);
        board.clearResult(state, match);
        return {matchId: match.matchId};
      });
      return afterResult(club, tournament, state, outcome.matchId, options);
    },
  },
  {
    name: "record_winner_stays_set",
    title: "Record winner-stays set",
    description: "Winner stays: records who won the current set. The loser is swapped for the resting player.",
    inputSchema: {type: "object", required: ["winner"], properties: {
      tournament: tournamentArg,
      winner: {type: "string", description: "The player who won the set."},
    }},
    annotations: write,
    async run(store, args, options) {
      const {club, tournament, state} = await change(store, args.tournament, state =>
        board.recordWinnerStaysSet(state, findPlayer(state, args.winner).id));
      const view = describeTournament(club, tournament, state, {appUrl: options.appUrl});
      return {recorded: true, winnerStays: view.winnerStays, podium: view.podium};
    },
  },
  {
    name: "finalize_tournament",
    title: "Finalize tournament",
    description: "Finishes the tournament: it becomes read-only, the club ranking is recalculated and followers are notified. Cannot be undone; only call after the user has explicitly confirmed. Refuses while matches are unplayed unless allowUnfinished is true.",
    inputSchema: {type: "object", properties: {
      tournament: tournamentArg,
      allowUnfinished: {type: "boolean", description: "Finalize even though some matches have no result."},
    }},
    annotations: destructive,
    async run(store, args, options) {
      const {club, tournament, state} = await change(store, args.tournament, (state, tournament) => {
        if (state.phase !== "play") fail("The tournament has not been started.");
        const unfinished = board.listMatches(state)
          .filter(match => !["done", "skipped"].includes(match.status));
        const winnerStaysOpen = state.gameMode === "winner-stays" && !state.winnerStays?.runnerUp;
        if ((unfinished.length || winnerStaysOpen) && !args.allowUnfinished) {
          fail((winnerStaysOpen ? "The winner-stays game is not decided. "
            : `${unfinished.length} match(es) have no final result: ` +
              unfinished.slice(0, 8).map(match => `${match.sides.join(" – ")} (${match.label})`).join("; ") + ". ") +
            "Ask the user, then retry with allowUnfinished: true to finalize anyway.");
        }
        tournament.status = "finalized";
        tournament.podium = board.podium(state);
      });
      return {finalized: true, ...describeTournament(club, tournament, state, {appUrl: options.appUrl, matches: "open"})};
    },
  },
];

function addPlayer(state, spoken, ctx) {
  const known = ctx.clubPlayerFor(board.sanitizeName(spoken));
  const player = board.addPlayer(state, spoken, ctx);
  return {name: player.name, newToClub: !known?.playerId,
    didYouMean: known?.playerId ? undefined : ctx.similar(player.name)};
}

const newClubPlayers = added => [...new Map(added.filter(entry => entry.newToClub)
  .map(({name, didYouMean}) => [name, {name, didYouMean}])).values()];

function afterResult(club, tournament, state, matchId, options) {
  const matches = board.listMatches(state);
  const match = matches.find(item => item.matchId === matchId);
  const view = describeTournament(club, tournament, state, {appUrl: options.appUrl});
  const pool = match?.stage === "pool" && state.pools > 1
    ? view.standings.find(table => match.label.startsWith("Pool " + table.pool + ","))
    : view.standings?.[0];
  return {
    saved: true,
    match: match && describeMatch(match),
    standings: match?.stage === "pool" ? pool : undefined,
    davisCup: view.davisCup,
    nextMatches: matches.filter(item => item.status === "open" || item.status === "in-progress")
      .slice(0, 5).map(describeMatch),
    openMatches: view.openMatches,
    podium: view.podium,
  };
}

/* ---- JSON-RPC --------------------------------------------------------- */

const rpcResult = (id, result) => ({jsonrpc: "2.0", id, result});
const rpcError = (id, code, message) => ({jsonrpc: "2.0", id: id ?? null, error: {code, message}});
const toolResult = (data, isError = false) => ({
  content: [{type: "text", text: typeof data === "string" ? data : JSON.stringify(data)}],
  ...(typeof data === "string" ? {} : {structuredContent: data}),
  ...(isError ? {isError: true} : {}),
});

async function dispatch(message, store, options) {
  const {id, method, params = {}} = message;
  switch (method) {
    case "initialize":
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(params.protocolVersion)
          ? params.protocolVersion : PROTOCOL_VERSIONS[0],
        capabilities: {tools: {listChanged: false}},
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, {tools: TOOLS.map(({run: _run, ...tool}) => tool)});
    case "resources/list":
      return rpcResult(id, {resources: []});
    case "resources/templates/list":
      return rpcResult(id, {resourceTemplates: []});
    case "prompts/list":
      return rpcResult(id, {prompts: []});
    case "tools/call": {
      const tool = TOOLS.find(candidate => candidate.name === params.name);
      if (!tool) return rpcError(id, -32602, `Unknown tool: ${params.name}`);
      try {
        return rpcResult(id, toolResult(await tool.run(store, params.arguments || {}, options)));
      } catch (error) {
        /* Rule violations go back to the model so it can ask the user. */
        if (error instanceof board.RuleError) return rpcResult(id, toolResult(error.message, true));
        console.error("MCP tool failed", params.name, error);
        return rpcResult(id, toolResult("Internal server error, please try again.", true));
      }
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

/*
 * Handles one HTTP request to the MCP endpoint. Returns {statusCode, body}
 * where body is undefined for an empty response.
 */
export async function handleMcpRequest({method, body}, store, options = {}) {
  if (method !== "POST") return {statusCode: 405, headers: {Allow: "POST"}, body: undefined};
  let parsed;
  try { parsed = JSON.parse(body || ""); }
  catch { return {statusCode: 400, body: rpcError(null, -32700, "Parse error")}; }
  const batch = Array.isArray(parsed);
  const messages = batch ? parsed : [parsed];
  const replies = [];
  for (const message of messages) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      /* Responses from the client to server requests are not expected. */
      if (message && "id" in message && !("result" in message || "error" in message))
        replies.push(rpcError(message.id, -32600, "Invalid request"));
      continue;
    }
    if (!("id" in message)) continue;   // notifications need no reply
    replies.push(await dispatch(message, store, options));
  }
  if (!replies.length) return {statusCode: 202, body: undefined};
  return {statusCode: 200, body: batch ? replies : replies[0]};
}
