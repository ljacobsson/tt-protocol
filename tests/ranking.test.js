import assert from "node:assert/strict";
import test from "node:test";

import {calculateRanking, matchPoints, rankingPeriod} from "../backend/ranking.js";

test("ranking table, championship bonus and walkover cap", () => {
  assert.equal(matchPoints(1000, 1000), 10);
  assert.equal(matchPoints(1100, 1000), 7);
  assert.equal(matchPoints(1000, 1100), 13);
  assert.equal(matchPoints(1000, 1100, {championship: true}), 19);
  assert.equal(matchPoints(500, 1100, {walkover: true}), 10);
});

test("ranking period starts on first Monday or next Swedish workday", () => {
  assert.equal(rankingPeriod("2026-07-26"), "2026-07-06");
  assert.equal(rankingPeriod("2026-08-02"), "2026-07-06");
  assert.equal(rankingPeriod("2026-08-03"), "2026-08-03");
  assert.equal(rankingPeriod("2023-05-01"), "2023-04-03");
  assert.equal(rankingPeriod("2023-05-02"), "2023-05-02");
});

test("players start at 1000 and recalculation is reproducible", () => {
  const tournaments = [{
    tournamentId: "t1",
    playedAt: "2026-07-26",
    type: "normal",
    status: "finalized",
    matches: [
      {matchId: "m1", winnerId: "a", loserId: "b", ranked: true},
      {matchId: "draw", winnerId: "a", loserId: "b", draw: true},
    ],
  }];
  const result = calculateRanking({a: "Ada", b: "Bo"}, tournaments);
  assert.deepEqual(result.players.map(({name, rating}) => [name, rating]), [
    ["Ada", 1010],
    ["Bo", 990],
  ]);
  assert.deepEqual(calculateRanking({a: "Ada", b: "Bo"}, tournaments), result);
});

test("period change is capped at 250", () => {
  const matches = Array.from({length: 30}, (_, i) => ({
    matchId: String(i), winnerId: "a", loserId: "b", ranked: true,
  }));
  const result = calculateRanking(
    {a: "Ada", b: "Bo"},
    [{tournamentId: "t", playedAt: "2026-07-26", status: "finalized", matches}],
  );
  assert.deepEqual(
    Object.fromEntries(result.players.map(player => [player.playerId, player.rating])),
    {a: 1250, b: 750},
  );
});

test("draft tournaments do not affect ranking until finalized", () => {
  const tournament = {
    tournamentId: "t",
    playedAt: "2026-07-26",
    status: "draft",
    matches: [{matchId: "m", winnerId: "a", loserId: "b", ranked: true}],
  };
  const draft = calculateRanking({a: "Ada", b: "Bo"}, [tournament]);
  assert.deepEqual(draft.players.map(player => player.rating), [1000, 1000]);

  tournament.status = "finalized";
  const finalized = calculateRanking({a: "Ada", b: "Bo"}, [tournament]);
  assert.deepEqual(finalized.players.map(player => player.rating), [1010, 990]);
});

test("a decided pool match counts even if legacy data marked it unranked", () => {
  const result = calculateRanking(
    {a: "Ada", b: "Bo"},
    [{
      tournamentId: "pool",
      playedAt: "2026-07-26",
      status: "finalized",
      matches: [{
        matchId: "pool:1_2",
        winnerId: "a",
        loserId: "b",
        ranked: false,
      }],
    }],
  );
  assert.deepEqual(result.players.map(player => player.rating), [1010, 990]);
});
