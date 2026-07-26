export const START_RATING = 1000;
export const MAX_PERIOD_CHANGE = 250;

const RANKING_TABLE = [
  [25, 10, 10],
  [50, 9, 11],
  [75, 8, 12],
  [100, 7, 13],
  [125, 6, 15],
  [150, 6, 16],
  [200, 5, 17],
  [250, 4, 18],
  [300, 3, 19],
  [400, 2, 20],
  [500, 2, 30],
  [Infinity, 2, 40],
];

const isoDate = date => date.toISOString().slice(0, 10);
const utcDate = (year, month, day) => new Date(Date.UTC(year, month, day));
const plusDays = (date, days) => new Date(date.getTime() + days * 86400000);

function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const ell = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * ell) / 451);
  const month = Math.floor((h + ell - 7 * m + 114) / 31);
  const day = ((h + ell - 7 * m + 114) % 31) + 1;
  return utcDate(year, month - 1, day);
}

function isSwedishPublicHoliday(date) {
  const monthDay = `${date.getUTCMonth() + 1}-${date.getUTCDate()}`;
  const fixed = new Set(["1-1", "1-6", "5-1", "6-6", "12-24", "12-25", "12-26", "12-31"]);
  const easter = easterSunday(date.getUTCFullYear());
  return fixed.has(monthDay) ||
    isoDate(date) === isoDate(plusDays(easter, -2)) ||
    isoDate(date) === isoDate(plusDays(easter, 1));
}

function periodStart(year, month) {
  const first = utcDate(year, month, 1);
  const daysUntilMonday = (8 - first.getUTCDay()) % 7;
  let start = plusDays(first, daysUntilMonday);
  while (start.getUTCDay() === 0 || start.getUTCDay() === 6 || isSwedishPublicHoliday(start)) {
    start = plusDays(start, 1);
  }
  return start;
}

export function rankingPeriod(value) {
  const day = new Date(`${String(value).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(day.getTime())) throw new Error("Ogiltigt speldatum");
  let start = periodStart(day.getUTCFullYear(), day.getUTCMonth());
  if (day < start) {
    const previous = utcDate(day.getUTCFullYear(), day.getUTCMonth(), 0);
    start = periodStart(previous.getUTCFullYear(), previous.getUTCMonth());
  }
  return isoDate(start);
}

export function matchPoints(winnerRating, loserRating, {
  championship = false,
  walkover = false,
} = {}) {
  const difference = Math.abs(winnerRating - loserRating);
  const [, favoritePoints, underdogPoints] =
    RANKING_TABLE.find(([upper]) => difference <= upper);
  let points = winnerRating >= loserRating ? favoritePoints : underdogPoints;
  if (championship) points = Math.floor(points * 1.5);
  if (walkover) points = Math.min(points, 10);
  return points;
}

export function calculateRanking(players, tournaments) {
  const names = {...players};
  const ratings = Object.fromEntries(Object.keys(names).map(id => [id, START_RATING]));
  const eventsByPeriod = new Map();

  for (const tournament of tournaments) {
    if (tournament.status !== "finalized") continue;
    const playedAt = tournament.playedAt || String(tournament.createdAt || "").slice(0, 10);
    const period = rankingPeriod(playedAt);
    if (!eventsByPeriod.has(period)) eventsByPeriod.set(period, []);
    for (const match of tournament.matches || []) {
      if (match.ranked === false || match.draw) continue;
      const {winnerId, loserId} = match;
      if (!(winnerId in names) || !(loserId in names) || winnerId === loserId) continue;
      eventsByPeriod.get(period).push({
        tournamentId: tournament.tournamentId,
        matchId: match.matchId || "",
        winnerId,
        loserId,
        championship: tournament.type === "championship",
        walkover: Boolean(match.walkover),
      });
    }
  }

  const history = [];
  for (const period of [...eventsByPeriod.keys()].sort()) {
    const baseline = {...ratings};
    const changes = {};
    const periodMatches = [];
    for (const event of eventsByPeriod.get(period)) {
      const points = matchPoints(baseline[event.winnerId], baseline[event.loserId], event);
      changes[event.winnerId] = (changes[event.winnerId] || 0) + points;
      changes[event.loserId] = (changes[event.loserId] || 0) - points;
      periodMatches.push({...event, points});
    }
    const applied = {};
    for (const [playerId, rawDelta] of Object.entries(changes)) {
      let delta = Math.max(-MAX_PERIOD_CHANGE, Math.min(MAX_PERIOD_CHANGE, rawDelta));
      if (baseline[playerId] <= 300 && delta < 0) delta = 0;
      ratings[playerId] += delta;
      applied[playerId] = delta;
    }
    history.push({period, changes: applied, matches: periodMatches});
  }

  return {
    players: Object.keys(names)
      .map(playerId => ({playerId, name: names[playerId], rating: ratings[playerId]}))
      .sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name, "sv")),
    periods: history,
  };
}
