import assert from "node:assert/strict";
import test from "node:test";

import {
  finishedMatchEvents,
  matchFinished,
  notificationFor,
  safeNotificationUrl,
  subscriberWants,
  validSubscription,
} from "../backend/push.js";

const participants = [
  {playerId: "anna", name: "Anna"},
  {playerId: "bo", name: "Bo"},
  {playerId: "cia", name: "Cia"},
];
const players = [
  {id: 1, name: "Anna", clubPlayerId: "anna", pool: 0},
  {id: 2, name: "Bo", clubPlayerId: "bo", pool: 0},
  {id: 3, name: "Cia", clubPlayerId: "cia", pool: 1},
];
const tournament = (state, matches) => ({
  tournamentId: "t1",
  name: "Klubbmästerskap",
  participants,
  state: {players, pools: 1, format: "bo3", results: {}, fresults: {}, ...state},
  matches,
});

test("matches are finished according to the match format", () => {
  assert.equal(matchFinished([[11, 5]], "bo7"), false);
  assert.equal(matchFinished([[11, 5], [11, 5], [11, 5]], "bo7"), false);
  assert.equal(matchFinished([[11, 5], [11, 5], [5, 11], [11, 5], [11, 5]], "bo7"), true);
  assert.equal(matchFinished([4, 3], "bo7"), true);
  assert.equal(matchFinished([2, 1], "bo5"), false);
  assert.equal(matchFinished([1, 1], "sets2"), true);
  assert.equal(matchFinished([1, 1], "sets2", true), false);
  assert.equal(matchFinished([1, 0], "sets1"), true);
  assert.equal(matchFinished(undefined, "bo3"), false);
});

test("only matches that became finished in this save are announced", () => {
  const before = tournament({results: {"1_2": [[11, 5]]}}, []);
  const after = tournament(
    {results: {"1_2": [[5, 11], [11, 9], [7, 11]]}},
    [{matchId: "pool:1_2", winnerId: "bo", loserId: "anna", setScore: [2, 1]}],
  );
  const [event, ...rest] = finishedMatchEvents(before, after);
  assert.equal(rest.length, 0);
  assert.deepEqual(event.names, ["Bo", "Anna"]);
  assert.deepEqual(event.setScore, [2, 1]);
  assert.deepEqual(event.sets, [[11, 5], [9, 11], [11, 7]]);
  assert.deepEqual(event.playerIds, ["bo", "anna"]);

  assert.deepEqual(finishedMatchEvents(after, after), []);
  const partial = tournament(
    {results: {"1_2": [[11, 5]]}},
    [{matchId: "pool:1_2", winnerId: "anna", loserId: "bo", setScore: [1, 0]}],
  );
  assert.deepEqual(finishedMatchEvents(tournament({}, []), partial), []);
});

test("draws, playoffs and pool names are described", () => {
  const before = tournament({format: "sets2", pools: 2}, []);
  const after = tournament({
    format: "sets2",
    pools: 2,
    results: {"1_2": [[5, 11], [11, 7]]},
    fresults: {"A1-B2": [[11, 3], [4, 11], [9, 11]]},
  }, [
    {matchId: "pool:1_2", playerAId: "bo", playerBId: "anna", draw: true, setScore: [1, 1]},
    {matchId: "final:A1-B2", winnerId: "cia", loserId: "anna", setScore: [2, 1]},
  ]);
  const [draw, final] = finishedMatchEvents(before, after);
  assert.equal(draw.draw, true);
  assert.deepEqual(draw.names, ["Bo", "Anna"]);
  assert.deepEqual(draw.sets, [[11, 5], [7, 11]]);
  assert.equal(draw.group, "Pool A");
  assert.equal(final.group, "Slutspel");
  assert.deepEqual(final.sets, [[3, 11], [11, 4], [11, 9]]);

  assert.deepEqual(notificationFor(draw, after, "/x"), {
    title: "Bo – Anna oavgjort",
    body: "1–1 (11–5, 7–11) · Pool A · Klubbmästerskap",
    tag: "t1:pool:1_2",
    url: "/x",
  });
  assert.equal(notificationFor(final, after, "/x").title, "Cia vann mot Anna");
});

test("subscribers can follow selected players or the whole tournament", () => {
  const event = {playerIds: ["anna", "bo"]};
  assert.equal(subscriberWants({playerIds: []}, event), true);
  assert.equal(subscriberWants({}, event), true);
  assert.equal(subscriberWants({playerIds: ["bo"]}, event), true);
  assert.equal(subscriberWants({playerIds: ["cia"]}, event), false);
});

test("subscription input is validated", () => {
  assert.equal(safeNotificationUrl("/clubs/bbtk/tournaments/abc"), "/clubs/bbtk/tournaments/abc");
  assert.equal(safeNotificationUrl("https://evil.example/clubs/a/tournaments/b"), "/");
  assert.equal(safeNotificationUrl("//evil.example"), "/");
  const keys = {p256dh: "B".repeat(87), auth: "a".repeat(22)};
  assert.ok(validSubscription({endpoint: "https://push.example/abc", keys}));
  assert.equal(validSubscription({endpoint: "http://push.example/abc", keys}), null);
  assert.equal(validSubscription({endpoint: "https://push.example/abc", keys: {}}), null);
});
