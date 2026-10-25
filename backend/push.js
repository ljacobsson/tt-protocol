/*
 * Push notifications for finished matches. Everything here is pure so the
 * decision of what to announce can be tested without DynamoDB or a push
 * service; app.js owns storage and delivery.
 */

const MAX_EVENTS_PER_SAVE = 10;

const setsOf = result => {
  if (!Array.isArray(result) || !result.length) return null;
  if (!Array.isArray(result[0])) return result.length >= 2
    ? [Number(result[0]) || 0, Number(result[1]) || 0] : null;
  return result.reduce(([a, b], set) => [
    a + (Number(set?.[0]) > Number(set?.[1]) ? 1 : 0),
    b + (Number(set?.[1]) > Number(set?.[0]) ? 1 : 0),
  ], [0, 0]);
};

/* Mirrors the frontend's matchDecided/pointsDone. Ball-point results are
   saved after every set, so a stored result is not necessarily finished. */
export function matchFinished(result, format = "sets2", knockout = false) {
  const sets = setsOf(result);
  if (!sets) return false;
  const total = sets[0] + sets[1];
  if (format === "sets1") return total >= 1;
  if (format === "sets2") return total >= 2 && (!knockout || sets[0] !== sets[1]);
  const needed = format === "bo7" ? 4 : format === "bo5" ? 3 : 2;
  return Math.max(...sets) >= needed;
}

function rawResult(state, matchId) {
  const [stage, key] = String(matchId || "").split(/:(.*)/s);
  if (stage === "pool") return {stage, key, result: state?.results?.[key]};
  if (stage === "final") return {stage, key, result: state?.fresults?.[key]};
  return null;
}

function poolName(index) {
  let name = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/* Matches that went from unfinished (or absent) to finished in this save. */
export function finishedMatchEvents(before, after) {
  if (!before || !after) return [];
  const names = Object.fromEntries((after.participants || [])
    .map(participant => [String(participant.playerId), participant.name]));
  const state = after.state || {};
  const events = [];
  for (const match of after.matches || []) {
    const now = rawResult(state, match.matchId);
    if (!now) continue;
    const knockout = now.stage === "final";
    if (!matchFinished(now.result, state.format, knockout)) continue;
    const previous = rawResult(before.state, match.matchId);
    if (matchFinished(previous?.result, before.state?.format, knockout)) continue;

    const draw = !!match.draw;
    const first = String(draw ? match.playerAId : match.winnerId || "");
    const second = String(draw ? match.playerBId : match.loserId || "");
    if (!first || !second) continue;
    const keyPlayer = knockout ? null : (state.players || [])
      .find(player => String(player.id) === now.key.split("_")[0]);
    let sets = Array.isArray(now.result?.[0]) ? now.result : null;
    const score = setsOf(now.result);
    /* Stored results follow pool/bracket order; announce winner-first, or
       for a draw in the order of the match record's players. */
    const flip = draw
      ? !!keyPlayer && String(keyPlayer.clubPlayerId || "") !== first
      : score[0] < score[1];
    if (sets && flip) sets = sets.map(([a, b]) => [b, a]);
    let group = knockout ? "Slutspel" : "";
    if (keyPlayer && Number(state.pools) > 1)
      group = "Pool " + poolName(Number(keyPlayer.pool) || 0);
    events.push({
      matchId: match.matchId,
      playerIds: [first, second],
      names: [names[first] || "Spelare", names[second] || "Spelare"],
      draw,
      setScore: flip ? [score[1], score[0]] : score,
      sets,
      group,
    });
  }
  return events.slice(0, MAX_EVENTS_PER_SAVE);
}

/* An empty or missing player filter follows the whole tournament. */
export function subscriberWants(subscription, event) {
  const filter = subscription.playerIds;
  if (!Array.isArray(filter) || !filter.length) return true;
  return event.playerIds.some(playerId => filter.includes(playerId));
}

export function notificationFor(event, tournament, url) {
  const [first, second] = event.names;
  const title = event.draw
    ? `${first} – ${second} oavgjort`
    : `${first} vann mot ${second}`;
  const score = event.setScore.join("–") + (event.sets
    ? " (" + event.sets.map(set => set.join("–")).join(", ") + ")"
    : "");
  return {
    title,
    body: [score, event.group, tournament.name].filter(Boolean).join(" · "),
    tag: `${tournament.tournamentId}:${event.matchId}`,
    url,
  };
}

/* Only same-origin tournament paths may be opened from a notification. */
export function safeNotificationUrl(value) {
  const url = String(value || "");
  return /^\/clubs\/[^\s?#]+\/tournaments\/[^\s?#]+$/.test(url) && url.length <= 300
    ? url : "/";
}

export function validSubscription(value) {
  const endpoint = String(value?.endpoint || "");
  const p256dh = String(value?.keys?.p256dh || "");
  const auth = String(value?.keys?.auth || "");
  if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000) return null;
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(p256dh) || !/^[A-Za-z0-9_-]{8,100}$/.test(auth)) return null;
  return {endpoint, keys: {p256dh, auth}};
}
