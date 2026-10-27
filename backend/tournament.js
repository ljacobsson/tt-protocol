/*
 * Server-side model of a tournament board, so a tournament can be set up and
 * scored without a browser (see mcp.js). It mirrors the frontend's state
 * handling in index.html: result orientation, standings, playoff slots, Davis
 * Cup, winner stays, ranking match records and the podium. The stored state
 * must stay readable by the frontend, so keep both in step when either
 * changes. Everything here is pure apart from generating player ids.
 */
import crypto from "node:crypto";

/* A change the rules of the board do not allow; safe to show to the user. */
export class RuleError extends Error {}

export const FORMATS = {
  sets1: {label: "1 set", results: [[1, 0], [0, 1]]},
  sets2: {label: "2 set", results: [[2, 0], [1, 1], [0, 2]]},
  bo3: {label: "Bäst av 3", results: [[2, 0], [2, 1], [1, 2], [0, 2]]},
  bo5: {label: "Bäst av 5", results: [[3, 0], [3, 1], [3, 2], [2, 3], [1, 3], [0, 3]]},
  bo7: {label: "Bäst av 7", results: [[4, 0], [4, 1], [4, 2], [4, 3], [3, 4], [2, 4], [1, 4], [0, 4]]},
};
export const GAME_MODES = ["pool", "winner-stays", "davis-cup"];
export const SCORING = ["sets", "points"];
export const FINALS = ["none", "place", "ab"];

/* In a 2-set playoff, a 1–1 score is followed by a deciding third set. */
export function playoffResults(format) {
  if (format === "sets1") return FORMATS.sets1.results;
  if (format === "sets2") return [[2, 0], [1, 1], [0, 2], [2, 1], [1, 2]];
  return FORMATS[format].results;
}

/* A result is [setsA, setsB] or, with ball points, [[a, b], [a, b], ...]. */
const isPoints = r => !!r && Array.isArray(r[0]);
export function flipResult(r) {
  if (!r) return null;
  return isPoints(r) ? r.map(g => [g[1], g[0]]) : [r[1], r[0]];
}
const cloneResult = r => r ? (isPoints(r) ? r.map(g => g.slice()) : r.slice()) : null;
export function setsOf(r) {
  if (!r) return null;
  if (!isPoints(r)) return [r[0], r[1]];
  let a = 0, b = 0;
  r.forEach(g => { if (g[0] > g[1]) a++; else if (g[1] > g[0]) b++; });
  return [a, b];
}
function ballsOf(r) {
  if (!isPoints(r)) return null;
  let a = 0, b = 0;
  r.forEach(g => { a += g[0]; b += g[1]; });
  return [a, b];
}

const setsToWin = state =>
  state.format === "sets1" ? 1 : state.format === "bo7" ? 4 : state.format === "bo5" ? 3 : 2;
export function matchDecided(state, r, needWinner) {
  const s = setsOf(r);
  if (!s) return false;
  if (state.format === "sets1") return s[0] + s[1] >= 1 && (!needWinner || s[0] !== s[1]);
  if (state.format === "sets2")
    return needWinner ? s[0] + s[1] >= 2 && s[0] !== s[1] : s[0] + s[1] >= 2;
  return s[0] >= setsToWin(state) || s[1] >= setsToWin(state);
}
/* How many sets a ball-point result may hold; the frontend's MAX_SETS. */
const maxSets = (state, needWinner) =>
  state.format === "sets1" ? 1 : state.format === "bo7" ? 7 : state.format === "bo5" ? 5
  : state.format === "bo3" ? 3 : needWinner ? 3 : 2;
/* The frontend's pointsDone: whether a ball-point match needs no more sets. */
function pointsDone(state, sets, needWinner) {
  const s = setsOf(sets.length ? sets : null) || [0, 0];
  if (state.format === "sets1") return sets.length >= 1;
  if (state.format === "sets2") return needWinner ? sets.length >= 2 && s[0] !== s[1] : sets.length >= 2;
  return s[0] >= setsToWin(state) || s[1] >= setsToWin(state);
}
/* 11 wins a set; from 10–10 the winner needs two points more. */
const validSet = ([a, b]) => {
  const win = Math.max(a, b), lose = Math.min(a, b);
  return Number.isInteger(a) && Number.isInteger(b) && lose >= 0 &&
    (lose <= 9 ? win === 11 : win === lose + 2);
};

/* Throws unless the result can be entered for a match in this format. */
export function validateResult(state, result, needWinner) {
  if (!Array.isArray(result) || !result.length) throw new RuleError("A result needs at least one set.");
  if (isPoints(result)) {
    const bad = result.find(set => !Array.isArray(set) || set.length !== 2 || !validSet(set));
    if (bad) throw new RuleError(`Invalid set score ${JSON.stringify(bad)}: a set is won 11–0…11–9, ` +
      "or by exactly two points after 10–10.");
    if (result.length > maxSets(state, needWinner))
      throw new RuleError(`${FORMATS[state.format].label} has at most ${maxSets(state, needWinner)} sets.`);
    for (let i = 1; i < result.length; i++) {
      if (pointsDone(state, result.slice(0, i), needWinner))
        throw new RuleError(`The match was already over after set ${i}.`);
    }
    return;
  }
  const allowed = needWinner ? playoffResults(state.format) : FORMATS[state.format].results;
  if (!allowed.some(([a, b]) => a === result[0] && b === result[1])) {
    throw new RuleError(`${result[0]}–${result[1]} is not a valid result for ` +
      `${FORMATS[state.format].label}${needWinner ? " in a playoff" : ""}. Valid: ` +
      allowed.map(r => r.join("–")).join(", ") + ".");
  }
}

export function poolName(index) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}
export const rkey = (a, b) => a < b ? a + "_" + b : b + "_" + a;
export const byId = (state, id) => state.players.find(p => p.id === id);
export const poolMembers = (state, i) => state.players.filter(p => (p.pool || 0) === i);
/* Names are compared like the frontend does: trimmed and case-insensitive. */
export const norm = s => String(s).trim().toLowerCase();
/* Tabs and newlines are the frontend link codec's separators. */
export const sanitizeName = n => String(n).replace(/[\t\r\n]+/g, " ").trim().slice(0, 24);

export function getResult(state, a, b) {
  const r = state.results[rkey(a, b)];
  if (!r) return null;
  return a < b ? cloneResult(r) : flipResult(r);
}
const getSets = (state, a, b) => setsOf(getResult(state, a, b));
const getF = (state, key) => cloneResult(state.fresults[key]);
const getFSets = (state, key) => setsOf(getF(state, key));

export function blankState(defaults = {}) {
  return {
    phase: "setup", format: "sets2", pools: 1, finals: "none",
    gameMode: "pool", winnerStaysTarget: 5, winnerStays: null, davisCup: {playAll: false},
    poolsManual: false, advance: 2, scoring: "sets",
    players: [], results: {}, fresults: {},
    rankingMatches: {}, useSeeding: true, nextId: 1, round: 0, view: "grid", pool: 0,
    ...defaults,
  };
}

/* Fills in fields that older saved boards may lack, like openTournament does. */
export function loadState(stored) {
  const state = Object.assign(blankState(), structuredClone(stored || {}));
  if (!state.rankingMatches) state.rankingMatches = {};
  if (!state.davisCup) state.davisCup = {playAll: false};
  if (!state.winnerStaysTarget) state.winnerStaysTarget = 5;
  if (state.useSeeding === undefined) state.useSeeding = true;
  return state;
}

/* ---- Standings -------------------------------------------------------- */

export function computeStandings(state, players) {
  const rows = players.map(p => ({p, m: 0, w: 0, d: 0, l: 0, sf: 0, sa: 0, bf: 0, ba: 0, pts: 0}));
  const idx = {};
  rows.forEach(r => idx[r.p.id] = r);
  for (const k of Object.keys(state.results)) {
    const [a, b] = k.split("_").map(Number);
    const ra = idx[a], rb = idx[b];
    if (!ra || !rb) continue;
    const raw = state.results[k];
    if (!matchDecided(state, raw)) continue;
    const [sa, sb] = setsOf(raw);
    ra.m++; rb.m++;
    ra.sf += sa; ra.sa += sb;
    rb.sf += sb; rb.sa += sa;
    const bp = ballsOf(raw);
    if (bp) { ra.bf += bp[0]; ra.ba += bp[1]; rb.bf += bp[1]; rb.ba += bp[0]; }
    if (sa > sb) { ra.w++; rb.l++; }
    else if (sa < sb) { rb.w++; ra.l++; }
    else { ra.d++; rb.d++; }
  }
  rows.forEach(r => r.pts = r.w * 2 + r.d);
  rows.sort((x, y) => {
    if (y.pts !== x.pts) return y.pts - x.pts;
    const h = getSets(state, x.p.id, y.p.id);
    if (h && h[0] !== h[1]) return h[1] - h[0];
    const dx = x.sf - x.sa, dy = y.sf - y.sa;
    if (dy !== dx) return dy - dx;
    if (y.sf !== x.sf) return y.sf - x.sf;
    const bx = x.bf - x.ba, by = y.bf - y.ba;
    if (by !== bx) return by - bx;
    return x.p.name.localeCompare(y.p.name, "sv");
  });
  return rows;
}

export function poolComplete(state, i) {
  const ids = poolMembers(state, i).map(p => p.id);
  for (let a = 0; a < ids.length; a++)
    for (let b = a + 1; b < ids.length; b++)
      if (!matchDecided(state, getResult(state, ids[a], ids[b]))) return false;
  return true;
}
const allPoolsComplete = state => {
  for (let i = 0; i < state.pools; i++) if (!poolComplete(state, i)) return false;
  return true;
};
const poolTables = state =>
  Array.from({length: state.pools}, (_, i) => computeStandings(state, poolMembers(state, i)));

/* ---- Playoffs --------------------------------------------------------- */

function seededField(state, ready) {
  const tables = poolTables(state);
  const field = [];
  const depth = Math.max(0, ...tables.map(t => t.length));
  for (let r = 0; r < depth; r++)
    for (let i = 0; i < state.pools; i++)
      if (tables[i][r]) field.push({p: ready ? tables[i][r].p : null, label: poolName(i) + (r + 1), rank: r});
  return field;
}

const roundName = (count, idx) =>
  count === 1 ? "Final" : count === 2 ? "Semifinal" : count === 4 ? "Kvartsfinal"
  : count === 8 ? "Åttondelsfinal" : "Omgång " + (idx + 1);

function seedOrder(n) {
  let o = [0];
  while (o.length < n) {
    const len = o.length * 2, next = [];
    o.forEach(v => { next.push(v); next.push(len - 1 - v); });
    o = next;
  }
  return o;
}

function buildBracket(state, field, name, pre, ready) {
  if (field.length < 2) return null;
  const size = Math.pow(2, Math.ceil(Math.log2(field.length)));
  const padded = [];
  for (let i = 0; i < size; i++) padded.push(field[i] || null);
  let slots = seedOrder(size).map(i => padded[i] ? {s: padded[i], live: true} : {s: null, live: false});
  const rounds = [];
  let r = 0;
  while (slots.length > 1) {
    const nodes = [], next = [];
    const count = slots.length / 2;
    for (let i = 0; i < slots.length; i += 2) {
      const top = slots[i], bot = slots[i + 1];
      const key = pre + r + "_" + (i / 2);
      const bye = top.live !== bot.live;
      const playable = top.live && bot.live;
      let winner = null;
      if (bye) winner = top.live ? top.s : bot.s;
      else if (playable && top.s && bot.s && ready) {
        const res = getF(state, key);
        const st = matchDecided(state, res, true) ? setsOf(res) : null;
        if (st && st[0] !== st[1]) winner = st[0] > st[1] ? top.s : bot.s;
      }
      const rn = roundName(count, r);
      nodes.push({
        key, top: top.live ? top.s : null, bot: bot.live ? bot.s : null,
        topFrom: top.from, botFrom: bot.from, bye, playable, tag: rn,
      });
      next.push({s: winner, live: top.live || bot.live, from: "Vinnare " + rn.toLowerCase() + " " + (i / 2 + 1)});
    }
    rounds.push({name: roundName(count, r), nodes});
    slots = next;
    r++;
  }
  return {name, pre, rounds, champion: slots[0] ? slots[0].s : null};
}

export function buildFinals(state) {
  if (state.gameMode !== "pool" || state.finals === "none" || state.pools < 2) return null;
  const ready = allPoolsComplete(state);
  if (state.finals === "place") {
    const tables = poolTables(state);
    const depth = Math.min(...tables.map(t => t.length));
    const matches = [];
    for (let r = 0; r < depth; r++) {
      const pos = r * 2 + 1;
      matches.push({
        key: "pl" + r,
        top: {p: ready ? tables[0][r].p : null, label: poolName(0) + (r + 1)},
        bot: {p: ready ? tables[1][r].p : null, label: poolName(1) + (r + 1)},
        playable: true, bye: false, tag: "Plats " + pos + "–" + (pos + 1),
      });
    }
    const spare = [];
    tables.forEach((t, i) => t.slice(depth).forEach(row =>
      spare.push({p: ready ? row.p : null, label: poolName(i) + (t.indexOf(row) + 1)})));
    return {mode: "place", ready, matches, spare};
  }
  const field = seededField(state, ready);
  let aField, bField;
  if (state.advance === "half") {
    const half = Math.ceil(field.length / 2);
    aField = field.slice(0, half);
    bField = field.slice(half);
  } else {
    const n = +state.advance || 2;
    aField = field.filter(e => e.rank < n);
    bField = field.filter(e => e.rank >= n);
  }
  if (aField.length === 1 && bField.length) { bField.unshift(aField[0]); aField = []; }
  const brackets = [
    buildBracket(state, aField, "A-slutspel", "a", ready),
    buildBracket(state, bField, "B-slutspel", "b", ready),
  ].filter(Boolean);
  return {mode: "ab", ready, brackets};
}

/* Berger / circle method; a pair with null means the other player rests. */
export function makeRounds(ids) {
  const ps = ids.slice();
  if (ps.length < 2) return [];
  if (ps.length % 2) ps.push(null);
  const m = ps.length, n1 = m - 1, rounds = [];
  for (let r = 0; r < n1; r++) {
    const pairs = [[ps[r % n1], ps[m - 1]]];
    for (let i = 1; i < m / 2; i++) pairs.push([ps[(r + i) % n1], ps[(r - i + n1) % n1]]);
    rounds.push(pairs);
  }
  return rounds;
}

/* ---- Davis Cup and winner stays -------------------------------------- */

export const davisCupTeams = state => [state.players.slice(0, 2), state.players.slice(2, 4)];
export function davisCupMatches(state) {
  const [[a, b], [x, y]] = davisCupTeams(state);
  return [
    {key: "davis:1", home: [a], away: [x]},
    {key: "davis:2", home: [b], away: [y]},
    {key: "davis:3", home: [a, b], away: [x, y], doubles: true},
    {key: "davis:4", home: [a], away: [y]},
    {key: "davis:5", home: [b], away: [x]},
  ];
}
export function davisCupStatus(state) {
  const wins = [0, 0];
  let draws = 0, open = 0;
  davisCupMatches(state).forEach(match => {
    const result = getF(state, match.key);
    if (!matchDecided(state, result)) { open++; return; }
    const sets = setsOf(result);
    if (sets[0] === sets[1]) draws++;
    else wins[sets[0] > sets[1] ? 0 : 1]++;
  });
  const lead = wins[0] - wins[1];
  const over = Math.abs(lead) > open || !open;
  return {wins, draws, open, over, winner: !over || !lead ? null : lead > 0 ? 0 : 1};
}

export function winnerStaysScores(state) {
  const scores = Object.fromEntries(state.players.map(player => [player.id, 0]));
  (state.winnerStays?.sets || []).forEach(set => {
    if (!set.tiebreak && set.winnerId in scores) scores[set.winnerId]++;
  });
  return scores;
}

function syncWinnerStaysRanking(state) {
  delete state.rankingMatches["winner-stays"];
  const game = state.winnerStays;
  if (!game?.champion || !game?.runnerUp || !game?.third) return;
  const [first, second, third] = [game.champion, game.runnerUp, game.third].map(id => byId(state, id));
  if (!first || !second || !third) return;
  [first, second, third].forEach(player => { player.clubPlayerId ||= crypto.randomUUID(); });
  state.rankingMatches["winner-stays"] = {
    matchId: "winner-stays", rankingMode: "winner-stays",
    winnerId: first.clubPlayerId, secondId: second.clubPlayerId, loserId: third.clubPlayerId,
  };
}

export function recordWinnerStaysSet(state, winnerId) {
  const game = state.winnerStays;
  if (state.gameMode !== "winner-stays" || state.phase !== "play" || !game)
    throw new RuleError("No winner-stays game is being played.");
  if (game.runnerUp) throw new RuleError("The winner-stays game is already decided.");
  if (!game.current.includes(winnerId))
    throw new RuleError("Only " + game.current.map(id => byId(state, id).name).join(" and ") +
      " are playing this set.");
  const loserId = game.current.find(id => id !== winnerId);
  game.sets.push({winnerId, loserId, tiebreak: Boolean(game.tiebreak)});
  if (game.tiebreak) {
    game.runnerUp = winnerId;
    game.third = loserId;
    game.tiebreak = false;
    syncWinnerStaysRanking(state);
    return;
  }
  const scores = winnerStaysScores(state);
  if (scores[winnerId] >= state.winnerStaysTarget) {
    game.champion = winnerId;
    const others = state.players.map(player => player.id).filter(id => id !== winnerId);
    if (scores[others[0]] === scores[others[1]]) {
      game.tiebreak = true;
      game.current = others;
      game.resting = winnerId;
    } else {
      game.runnerUp = scores[others[0]] > scores[others[1]] ? others[0] : others[1];
      game.third = game.runnerUp === others[0] ? others[1] : others[0];
      syncWinnerStaysRanking(state);
    }
  } else {
    game.current = [winnerId, game.resting];
    game.resting = loserId;
  }
}

/* ---- Ranking match records -------------------------------------------- */

function syncRankingMatch(state, matchId, a, b, result) {
  const pa = byId(state, a), pb = byId(state, b);
  const sets = setsOf(result);
  if (!pa || !pb || !sets) {
    delete state.rankingMatches[matchId];
    return;
  }
  pa.clubPlayerId ||= crypto.randomUUID();
  pb.clubPlayerId ||= crypto.randomUUID();
  if (sets[0] === sets[1]) {
    state.rankingMatches[matchId] = {
      matchId, playerAId: pa.clubPlayerId, playerBId: pb.clubPlayerId,
      draw: true, ranked: true, setScore: sets,
    };
    return;
  }
  const aWon = sets[0] > sets[1];
  state.rankingMatches[matchId] = {
    matchId,
    winnerId: aWon ? pa.clubPlayerId : pb.clubPlayerId,
    loserId: aWon ? pb.clubPlayerId : pa.clubPlayerId,
    ranked: true,
    setScore: aWon ? sets : [sets[1], sets[0]],
  };
}
const clearFinalRankingMatches = state => Object.keys(state.rankingMatches).forEach(key => {
  if (key.startsWith("final:")) delete state.rankingMatches[key];
});

/* ---- Matches ---------------------------------------------------------- */

const slotName = (slot, from) => slot?.p ? slot.p.name : slot ? slot.label : from || "?";

/*
 * Every match of the board with its players, oriented the way results are
 * entered: `sides[0]` is the first number of a score. Status is one of
 * done, in-progress (some sets entered), open, waiting (players not known
 * yet) or skipped (Davis Cup meeting already decided).
 */
export function listMatches(state) {
  const matches = [];
  const status = (result, needWinner) =>
    matchDecided(state, result, needWinner) ? "done" : result ? "in-progress" : "open";
  if (state.gameMode === "pool") {
    for (let pool = 0; pool < state.pools; pool++) {
      const players = state.pools > 1 ? poolMembers(state, pool) : state.players;
      makeRounds(players.map(p => p.id)).forEach((pairs, round) => {
        for (const pair of pairs) {
          if (pair.includes(null)) continue;
          const [a, b] = pair.slice().sort((x, y) => x - y);
          const result = getResult(state, a, b);
          matches.push({
            matchId: "pool:" + rkey(a, b),
            stage: "pool",
            label: (state.pools > 1 ? "Pool " + poolName(pool) + ", " : "") + "rond " + (round + 1),
            round: round + 1,
            sides: [byId(state, a).name, byId(state, b).name],
            playerIds: [a, b],
            needWinner: false,
            status: status(result, false),
            result,
          });
        }
      });
    }
    const finals = buildFinals(state);
    const nodes = !finals ? []
      : finals.mode === "place" ? finals.matches.map(node => ({node, label: node.tag}))
      : finals.brackets.flatMap(bracket => bracket.rounds.flatMap(round =>
        round.nodes.filter(node => node.playable).map((node, index, all) => ({
          node,
          label: bracket.name + " " + node.tag.toLowerCase() +
            (all.length > 1 ? " " + (index + 1) : ""),
        }))));
    for (const {node, label} of nodes) {
      const known = node.top?.p && node.bot?.p;
      const result = getF(state, node.key);
      matches.push({
        matchId: "final:" + node.key,
        stage: "playoff",
        label,
        sides: [slotName(node.top, node.topFrom), slotName(node.bot, node.botFrom)],
        playerIds: known ? [node.top.p.id, node.bot.p.id] : null,
        needWinner: true,
        status: known ? status(result, true) : "waiting",
        result,
      });
    }
  }
  if (state.gameMode === "davis-cup" && state.players.length >= 4) {
    const over = davisCupStatus(state).over && !state.davisCup?.playAll;
    davisCupMatches(state).forEach((match, index) => {
      const result = getF(state, match.key);
      matches.push({
        matchId: "final:" + match.key,
        stage: "davis-cup",
        label: "Match " + (index + 1) + (match.doubles ? " (dubbel)" : ""),
        sides: [match.home, match.away].map(team => team.map(p => p.name).join(" / ")),
        playerIds: match.doubles ? null : [match.home[0].id, match.away[0].id],
        teams: [match.home.map(p => p.id), match.away.map(p => p.id)],
        doubles: !!match.doubles,
        needWinner: false,
        status: !result && over ? "skipped" : status(result, false),
        result,
      });
    });
  }
  return matches;
}

/* Stores a result oriented to match.sides; the frontend's setResultRaw/setFRaw. */
export function recordResult(state, match, result) {
  if (state.phase !== "play") throw new RuleError("The tournament has not been started yet.");
  if (match.status === "waiting")
    throw new RuleError(match.label + " cannot be played until the earlier rounds are finished.");
  if (match.status === "skipped") throw new RuleError("The Davis Cup meeting is already decided.");
  validateResult(state, result, match.needWinner);
  const [stage, key] = match.matchId.split(/:(.*)/s);
  if (stage === "pool") {
    const [a, b] = match.playerIds;
    state.results[rkey(a, b)] = a < b ? cloneResult(result) : flipResult(result);
  } else {
    state.fresults[key] = cloneResult(result);
  }
  const [a, b] = match.playerIds || [null, null];
  syncRankingMatch(state, match.matchId, a, b, result);
}

export function clearResult(state, match) {
  const [stage, key] = match.matchId.split(/:(.*)/s);
  if (stage === "pool") delete state.results[key];
  else delete state.fresults[key];
  delete state.rankingMatches[match.matchId];
}

/* ---- Setup ------------------------------------------------------------ */

export const playerLimit = state =>
  state.gameMode === "winner-stays" ? 3 : state.gameMode === "davis-cup" ? 4 : Infinity;

export function recommendedPoolCount(playerCount) {
  if (playerCount < 2) return 1;
  const maxPools = Math.max(1, Math.floor(playerCount / 2));
  return Math.min(maxPools, Math.max(1, Math.round(playerCount / 4)));
}

/* Spread players across pools snake-style; ratingOf returns null without a club. */
export function autoAssignPools(state, ratingOf) {
  const n = state.pools;
  const ranked = state.useSeeding !== false && state.players.some(p => ratingOf(p) !== null);
  const players = ranked ? state.players.slice().sort((a, b) => {
    const ar = ratingOf(a), br = ratingOf(b);
    if (ar === null && br === null) return state.players.indexOf(a) - state.players.indexOf(b);
    if (ar === null) return 1;
    if (br === null) return -1;
    return br - ar || state.players.indexOf(a) - state.players.indexOf(b);
  }) : state.players;
  players.forEach((p, i) => {
    const row = Math.floor(i / n), col = i % n;
    p.pool = row % 2 === 0 ? col : n - 1 - col;
  });
}

function smallestPool(state) {
  let best = 0, n = Infinity;
  for (let i = 0; i < state.pools; i++) {
    const c = poolMembers(state, i).length;
    if (c < n) { n = c; best = i; }
  }
  return best;
}

/* What renderSetup/renderPoolChoice enforce each time the setup is shown. */
export function normalizeSetup(state, ratingOf) {
  const maxPools = Math.max(1, Math.floor(state.players.length / 2));
  const selected = state.poolsManual
    ? Math.min(maxPools, Math.max(1, state.pools || 1))
    : recommendedPoolCount(state.players.length);
  if (selected !== state.pools) {
    state.pools = selected;
    state.pool = 0;
    if (selected === 1) state.players.forEach(player => player.pool = 0);
    else autoAssignPools(state, ratingOf);
  }
  if (state.pools > 2 && state.finals === "place") state.finals = "ab";
}

export function addPlayer(state, rawName, {ratingOf, clubPlayerFor}) {
  if (state.players.length >= playerLimit(state))
    throw new RuleError(`This game mode takes exactly ${playerLimit(state)} players.`);
  const name = sanitizeName(rawName);
  if (!name) throw new RuleError("A player needs a name.");
  const existing = state.players.find(p => norm(p.name) === norm(name));
  if (existing) return existing;
  const known = clubPlayerFor(name);
  const player = {
    id: state.nextId++, name: known?.name || name, pool: smallestPool(state),
    clubPlayerId: known?.playerId || crypto.randomUUID(),
  };
  state.players.push(player);
  if (state.gameMode === "winner-stays") state.winnerStays = null;
  if (state.pools > 1 && state.useSeeding !== false) autoAssignPools(state, ratingOf);
  return player;
}

export function removePlayer(state, player, {ratingOf}) {
  state.players = state.players.filter(x => x.id !== player.id);
  if (state.gameMode === "winner-stays") state.winnerStays = null;
  // Removing a player shifts the A/B/X/Y lineup, so no result still applies.
  if (state.gameMode === "davis-cup") { state.fresults = {}; state.rankingMatches = {}; }
  Object.keys(state.rankingMatches).forEach(key => {
    const match = state.rankingMatches[key];
    if ([match.winnerId, match.loserId, match.playerAId, match.playerBId].includes(player.clubPlayerId))
      delete state.rankingMatches[key];
  });
  for (const k of Object.keys(state.results)) {
    if (k.split("_").map(Number).includes(player.id)) delete state.results[k];
  }
  if (state.pools > 1 && state.useSeeding !== false) autoAssignPools(state, ratingOf);
}

const hasResults = state => Object.keys(state.results).length > 0 ||
  Object.keys(state.fresults).length > 0 || state.winnerStays?.sets?.length > 0;

/*
 * Applies setup changes in the order the setup screen presents them. Changes
 * that the frontend confirms because they wipe results throw unless
 * clearResults is set.
 */
export function applySettings(state, changes, {ratingOf}) {
  const wipe = what => {
    if (hasResults(state) && !changes.clearResults)
      throw new RuleError(`Changing ${what} clears all entered results. Ask the user, then retry with clearResults: true.`);
  };
  if (changes.gameMode !== undefined && changes.gameMode !== state.gameMode) {
    if (!GAME_MODES.includes(changes.gameMode)) throw new RuleError("Unknown game mode.");
    wipe("the game mode");
    state.gameMode = changes.gameMode;
    state.results = {}; state.fresults = {}; state.rankingMatches = {};
    state.winnerStays = null;
    if (state.gameMode === "winner-stays") {
      state.pools = 1; state.finals = "none"; state.format = "sets1"; state.scoring = "sets";
    }
    if (state.gameMode === "davis-cup") {
      state.pools = 1; state.finals = "none"; state.format = "bo5";
      state.players.forEach(p => p.pool = 0);
    }
  }
  if (changes.format !== undefined && changes.format !== state.format) {
    if (!FORMATS[changes.format]) throw new RuleError("Unknown match format.");
    wipe("the match format");
    state.results = {}; state.fresults = {}; state.rankingMatches = {};
    state.format = changes.format;
  }
  if (changes.scoring !== undefined && changes.scoring !== state.scoring) {
    if (!SCORING.includes(changes.scoring)) throw new RuleError("Unknown scoring.");
    wipe("the scoring");
    state.scoring = changes.scoring;
    state.results = {}; state.fresults = {}; state.rankingMatches = {};
  }
  if (changes.winnerStaysTarget !== undefined) {
    const target = Math.trunc(Number(changes.winnerStaysTarget));
    if (!(target >= 1 && target <= 8)) throw new RuleError("winnerStaysTarget must be 1–8.");
    if (target !== state.winnerStaysTarget) {
      wipe("the winning target");
      state.winnerStaysTarget = target;
      state.winnerStays = null;
      state.rankingMatches = {};
    }
  }
  if (changes.davisCupPlayAll !== undefined) state.davisCup.playAll = !!changes.davisCupPlayAll;
  if (changes.pools !== undefined && changes.pools !== state.pools) {
    const n = Math.trunc(Number(changes.pools));
    const maxPools = Math.max(1, Math.floor(state.players.length / 2));
    if (!(n >= 1 && n <= maxPools)) throw new RuleError(`With ${state.players.length} players, choose 1–${maxPools} pools.`);
    if (Object.keys(state.fresults).length && !changes.clearResults)
      throw new RuleError("Changing the number of pools clears the playoff results. Ask the user, then retry with clearResults: true.");
    state.pools = n;
    state.poolsManual = true;
    state.fresults = {};
    clearFinalRankingMatches(state);
    state.pool = 0;
    if (n === 1) state.players.forEach(p => p.pool = 0);
    else autoAssignPools(state, ratingOf);
    if (n > 2 && state.finals === "place") state.finals = "ab";
  }
  if (changes.useSeeding !== undefined) {
    state.useSeeding = !!changes.useSeeding;
    if (state.pools > 1) autoAssignPools(state, ratingOf);
  }
  if (changes.finals !== undefined) {
    if (!FINALS.includes(changes.finals)) throw new RuleError("Unknown playoff type.");
    if (changes.finals === "place" && state.pools !== 2)
      throw new RuleError("Placement matches need exactly 2 pools.");
    if (changes.finals !== state.finals) { state.fresults = {}; clearFinalRankingMatches(state); }
    state.finals = changes.finals;
  }
  if (changes.advance !== undefined) {
    const value = changes.advance === "half" ? "half" : Math.trunc(Number(changes.advance));
    if (value !== "half" && ![1, 2, 3].includes(value)) throw new RuleError('advance must be 1, 2, 3 or "half".');
    if (value !== state.advance) {
      state.advance = value;
      state.fresults = {};
      clearFinalRankingMatches(state);
    }
  }
}

/* ---- Placements ------------------------------------------------------- */

function rowsSharePlace(state, a, b) {
  if (a.pts !== b.pts || a.sf - a.sa !== b.sf - b.sa || a.sf !== b.sf ||
      a.bf - a.ba !== b.bf - b.ba) return false;
  const head = getSets(state, a.p.id, b.p.id);
  return !head || head[0] === head[1];
}

function groupedPoolRows(state, rows, startPlace) {
  const groups = [];
  let i = 0;
  while (i < rows.length) {
    const players = [rows[i].p];
    let j = i + 1;
    while (j < rows.length && rowsSharePlace(state, rows[i], rows[j])) players.push(rows[j++].p);
    groups.push({place: startPlace + i, players});
    i = j;
  }
  return groups;
}

function bracketResultGroups(state, bracket, offset) {
  const assigned = new Set();
  const groups = new Map();
  const add = (place, player) => {
    if (!player || assigned.has(player.id)) return;
    assigned.add(player.id);
    if (!groups.has(place)) groups.set(place, []);
    groups.get(place).push(player);
  };
  if (bracket.champion?.p) add(offset + 1, bracket.champion.p);
  const totalRounds = bracket.rounds.length;
  bracket.rounds.forEach((round, roundIndex) => {
    const place = offset + Math.pow(2, totalRounds - roundIndex - 1) + 1;
    round.nodes.forEach(node => {
      if (!node.playable || !node.top?.p || !node.bot?.p) return;
      const result = getFSets(state, node.key);
      if (!result || result[0] === result[1]) return;
      add(place, result[0] > result[1] ? node.bot.p : node.top.p);
    });
  });
  const allPlayers = new Map();
  bracket.rounds.forEach(round => round.nodes.forEach(node =>
    [node.top, node.bot].forEach(slot => { if (slot?.p) allPlayers.set(slot.p.id, slot.p); })));
  const nextPlace = offset + assigned.size + 1;
  allPlayers.forEach(player => add(nextPlace, player));
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([place, players]) => ({place, players}));
}

export function finalResultGroups(state) {
  if (!state.players.length) return [];
  const find = id => byId(state, id);
  if (state.gameMode === "winner-stays" && state.winnerStays?.champion) {
    const game = state.winnerStays;
    if (!game.runnerUp || !game.third) return [{place: 1, players: [find(game.champion)]}];
    return [
      {place: 1, players: [find(game.champion)]},
      {place: 2, players: [find(game.runnerUp)]},
      {place: 3, players: [find(game.third)]},
    ];
  }
  if (state.gameMode === "davis-cup") {
    const score = davisCupStatus(state).wins;
    const teams = davisCupTeams(state);
    if (score[0] === score[1]) return [{place: 1, players: teams.flat()}];
    const winner = score[0] > score[1] ? 0 : 1;
    return [{place: 1, players: teams[winner]}, {place: 2, players: teams[1 - winner]}];
  }
  if (Array.isArray(state.importedPlacements) && state.importedPlacements.length) {
    return state.importedPlacements.map(group => ({
      place: group.place, players: group.playerIds.map(find).filter(Boolean),
    })).filter(group => group.players.length);
  }
  const finals = buildFinals(state);
  if (!finals) {
    if (state.pools === 1) return groupedPoolRows(state, computeStandings(state, state.players), 1);
    const tables = poolTables(state);
    const groups = [];
    let place = 1;
    const depth = Math.max(0, ...tables.map(table => table.length));
    for (let rank = 0; rank < depth; rank++) {
      const players = tables.filter(table => table[rank]).map(table => table[rank].p);
      if (players.length) { groups.push({place, players}); place += players.length; }
    }
    return groups;
  }
  if (finals.mode === "place") {
    const groups = [];
    finals.matches.forEach((match, index) => {
      const firstPlace = index * 2 + 1;
      const result = getFSets(state, match.key);
      const top = match.top?.p, bot = match.bot?.p;
      if (!top || !bot) return;
      if (!result || result[0] === result[1]) groups.push({place: firstPlace, players: [top, bot]});
      else {
        groups.push({place: firstPlace, players: [result[0] > result[1] ? top : bot]});
        groups.push({place: firstPlace + 1, players: [result[0] > result[1] ? bot : top]});
      }
    });
    let place = finals.matches.length * 2 + 1;
    finals.spare.forEach(slot => { if (slot.p) groups.push({place: place++, players: [slot.p]}); });
    return groups;
  }
  const groups = [];
  let offset = 0;
  finals.brackets.forEach(bracket => {
    const ids = new Set();
    bracket.rounds.forEach(round => round.nodes.forEach(node =>
      [node.top, node.bot].forEach(slot => { if (slot?.p) ids.add(slot.p.id); })));
    groups.push(...bracketResultGroups(state, bracket, offset));
    offset += ids.size;
  });
  const assigned = new Set(groups.flatMap(group => group.players.map(player => player.id)));
  const remaining = state.players.filter(player => !assigned.has(player.id));
  if (remaining.length) groups.push({place: offset + 1, players: remaining});
  return groups;
}

/* The podium sent along when finalizing, as the frontend computes it. */
export const podium = state => finalResultGroups(state)
  .filter(group => group.place <= 3)
  .slice(0, 3)
  .map(group => ({place: group.place, names: group.players.map(player => player.name)}));

/* Start conditions of the setup screen's start button. */
export function startProblem(state) {
  const n = state.players.length;
  if (playerLimit(state) !== Infinity && n !== playerLimit(state))
    return `This game mode needs exactly ${playerLimit(state)} players (has ${n}).`;
  if (n < 2) return "At least 2 players are needed.";
  for (let i = 0; i < state.pools; i++)
    if (poolMembers(state, i).length < 2) return `Pool ${poolName(i)} needs at least 2 players.`;
  return null;
}

export function start(state) {
  const problem = startProblem(state);
  if (problem) throw new RuleError(problem);
  state.phase = "play";
  state.round = 0;
  state.pool = 0;
  state.view = "grid";
  if (state.gameMode === "winner-stays" && !state.winnerStays)
    state.winnerStays = {sets: [], current: [state.players[0].id, state.players[1].id],
      resting: state.players[2].id, champion: null, tiebreak: false};
}

/* The save payload the frontend's tournamentPayload builds. */
export function tournamentPayload(tournament, state) {
  return {
    name: tournament.name,
    playedAt: tournament.playedAt,
    type: tournament.type || "normal",
    status: tournament.status || "draft",
    expectedUpdatedAt: tournament.updatedAt || null,
    state,
    participants: state.players.map(p => ({playerId: p.clubPlayerId, name: p.name})),
    matches: Object.values(state.rankingMatches || {}),
    podium: tournament.status === "finalized" ? tournament.podium : undefined,
  };
}
