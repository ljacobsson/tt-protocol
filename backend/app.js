import crypto from "node:crypto";

import {
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import {START_RATING, calculateRanking} from "./ranking.js";

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: {removeUndefinedValues: true},
});
const TABLE_NAME = process.env.TABLE_NAME;
const ORIGIN = process.env.ALLOWED_ORIGIN || "*";

const now = () => new Date().toISOString();
const clubPk = clubId => `CLUB#${clubId}`;
const aliasPk = alias => `ALIAS#${alias}`;
const tokenHash = token => crypto.createHash("sha256").update(token).digest("hex");
const validAlias = alias => /^[a-z0-9][a-z0-9-]{1,31}$/.test(alias);
const PASSWORD_REQUIRED = Symbol("PASSWORD_REQUIRED");
const spectatorPasswordAccepted = (event, meta) => {
  if (!meta.spectatorPasswordHash) return true;
  const headers = event.headers || {};
  const password = headers["X-Spectator-Password"] ||
    headers["x-spectator-password"] || "";
  const actual = Buffer.from(meta.spectatorPasswordHash, "hex");
  const supplied = Buffer.from(tokenHash(password), "hex");
  return actual.length === supplied.length &&
    crypto.timingSafeEqual(actual, supplied);
};
const aliasFromName = name => {
  const slug = String(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
  if (slug.length >= 2) return slug;
  return slug ? `${slug}-klubb` : "klubb";
};
const aliasVariation = (base, attempt) => {
  if (attempt === 0) return base;
  const suffix = `-${attempt + 1}`;
  return base.slice(0, 32 - suffix.length).replace(/-+$/g, "") + suffix;
};

async function resolveClubId(identifier) {
  if (!identifier) return null;
  const {Item: direct} = await db.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {PK: clubPk(identifier), SK: "META"},
    ConsistentRead: true,
    ProjectionExpression: "clubId",
  }));
  if (direct) return direct.clubId;
  const alias = String(identifier).toLowerCase();
  if (!validAlias(alias)) return null;
  const {Item: reference} = await db.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {PK: aliasPk(alias), SK: "META"},
    ConsistentRead: true,
    ProjectionExpression: "clubId",
  }));
  if (reference?.clubId) return reference.clubId;

  /*
   * Backward compatibility for aliases added directly to an existing META
   * record before alias lookup records were introduced. This slow path runs
   * only once per migrated alias and repairs the lookup for future requests.
   */
  let startKey;
  do {
    const page = await db.send(new ScanCommand({
      TableName: TABLE_NAME,
      FilterExpression: "SK = :meta AND #alias = :alias",
      ExpressionAttributeNames: {"#alias": "alias"},
      ExpressionAttributeValues: {":meta": "META", ":alias": alias},
      ProjectionExpression: "clubId",
      ExclusiveStartKey: startKey,
    }));
    const clubId = page.Items?.find(item => item.clubId)?.clubId;
    if (clubId) {
      try {
        await db.send(new PutCommand({
          TableName: TABLE_NAME,
          Item: {PK: aliasPk(alias), SK: "META", clubId, alias, createdAt: now()},
          ConditionExpression: "attribute_not_exists(PK)",
        }));
      } catch (error) {
        if (error.name !== "ConditionalCheckFailedException") throw error;
      }
      return clubId;
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return null;
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": ORIGIN,
      "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Spectator-Password",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
    body: body === undefined ? "" : JSON.stringify(body),
  };
}

function bodyOf(event) {
  const raw = event.body || "{}";
  return JSON.parse(event.isBase64Encoded
    ? Buffer.from(raw, "base64").toString("utf8")
    : raw);
}

async function authorize(event, clubId, requestedClubId = clubId) {
  const headers = event.headers || {};
  const authorization = headers.Authorization || headers.authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const {Item: meta} = await db.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {PK: clubPk(clubId), SK: "META"},
    ConsistentRead: true,
  }));
  if (!meta || !token) return null;
  /* The unguessable club id is also the credential for the canonical link. */
  if (token === clubId) return meta;
  /* Club links are collaborative: the configured alias may also submit
     results after the frontend has resolved it to the canonical club id. */
  if (token === requestedClubId ||
      (meta.alias && token.toLowerCase() === String(meta.alias).toLowerCase()))
    return spectatorPasswordAccepted(event, meta) ? meta : PASSWORD_REQUIRED;
  const actual = Buffer.from(meta.tokenHash, "hex");
  const supplied = Buffer.from(tokenHash(token), "hex");
  return actual.length === supplied.length && crypto.timingSafeEqual(actual, supplied)
    ? meta
    : null;
}

async function queryClub(clubId) {
  const {Items = []} = await db.send(new QueryCommand({
    TableName: TABLE_NAME,
    KeyConditionExpression: "PK = :pk",
    ExpressionAttributeValues: {":pk": clubPk(clubId)},
    ConsistentRead: true,
  }));
  return Items;
}

const withoutKeys = ({PK: _pk, SK: _sk, ...item}) => item;

function publicClub(items) {
  const meta = items.find(item => item.SK === "META");
  const tournaments = items
    .filter(item => item.SK.startsWith("TOURNAMENT#"))
    .map(withoutKeys)
    .sort((a, b) =>
      String(b.playedAt || "").localeCompare(String(a.playedAt || "")) ||
      String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
  const players = items
    .filter(item => item.SK.startsWith("PLAYER#"))
    .map(withoutKeys)
    .sort((a, b) => b.rating - a.rating || a.name.localeCompare(b.name, "sv"));
  const savedNames = Object.hasOwn(meta, "savedNames")
    ? meta.savedNames
    : players.map(player => player.name);
  const names = Object.fromEntries(players.map(player => [player.playerId, player.name]));
  const ranking = calculateRanking(names, tournaments);
  const tournamentById = Object.fromEntries(
    tournaments.map(tournament => [tournament.tournamentId, tournament]),
  );
  const setsOf = result => {
    if (!Array.isArray(result)) return null;
    if (!Array.isArray(result[0])) return result.length >= 2
      ? [Number(result[0]) || 0, Number(result[1]) || 0] : null;
    return result.reduce(([a, b], set) => [
      a + (Number(set?.[0]) > Number(set?.[1]) ? 1 : 0),
      b + (Number(set?.[1]) > Number(set?.[0]) ? 1 : 0),
    ], [0, 0]);
  };
  const storedSetScore = (tournament, match) => {
    if (Array.isArray(match.setScore)) return match.setScore;
    const [stage, key] = String(match.matchId || "").split(/:(.*)/s);
    let score = null;
    if (stage === "pool") score = setsOf(tournament.state?.results?.[key]);
    if (stage === "final") score = setsOf(tournament.state?.fresults?.[key]);
    /* Legacy results are stored in bracket/pool order. A ranked match is
       exposed winner-first, so normalize the recovered score the same way. */
    if (score && !match.draw && score[0] < score[1]) score = [score[1], score[0]];
    return score;
  };
  const playerDetails = Object.fromEntries(ranking.players.map(player => [
    player.playerId,
    {
      ...player,
      matches: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      totalChange: player.rating - START_RATING,
      rankingMatches: [],
      periods: [],
    },
  ]));
  for (const period of ranking.periods) {
    for (const [playerId, change] of Object.entries(period.changes)) {
      if (playerDetails[playerId]) {
        playerDetails[playerId].periods.push({period: period.period, change});
      }
    }
    for (const match of period.matches) {
      const tournament = tournamentById[match.tournamentId] || {};
      const sourceMatch = (tournament.matches || []).find(item =>
        String(item.matchId || "") === String(match.matchId || ""));
      const setScore = storedSetScore(tournament, sourceMatch || match);
      if (match.draw) {
        const playerA = playerDetails[match.playerAId];
        const playerB = playerDetails[match.playerBId];
        if (!playerA || !playerB) continue;
        playerA.matches++;
        playerA.draws++;
        playerB.matches++;
        playerB.draws++;
        playerA.rankingMatches.push({
          matchId: match.matchId,
          tournamentId: match.tournamentId,
          tournamentName: tournament.name || "Tävling",
          playedAt: tournament.playedAt,
          period: period.period,
          opponentId: playerB.playerId,
          opponentName: playerB.name,
          outcome: "draw",
          change: match.pointsA,
          setScore,
        });
        playerB.rankingMatches.push({
          matchId: match.matchId,
          tournamentId: match.tournamentId,
          tournamentName: tournament.name || "Tävling",
          playedAt: tournament.playedAt,
          period: period.period,
          opponentId: playerA.playerId,
          opponentName: playerA.name,
          outcome: "draw",
          change: match.pointsB,
          setScore: setScore ? [setScore[1], setScore[0]] : null,
        });
        continue;
      }
      const winner = playerDetails[match.winnerId];
      const loser = playerDetails[match.loserId];
      if (winner && loser) {
        winner.matches++;
        winner.wins++;
        loser.matches++;
        loser.losses++;
        winner.rankingMatches.push({
          matchId: match.matchId,
          tournamentId: match.tournamentId,
          tournamentName: tournament.name || "Tävling",
          playedAt: tournament.playedAt,
          period: period.period,
          opponentId: loser.playerId,
          opponentName: loser.name,
          outcome: "win",
          change: match.points,
          setScore,
        });
        loser.rankingMatches.push({
          matchId: match.matchId,
          tournamentId: match.tournamentId,
          tournamentName: tournament.name || "Tävling",
          playedAt: tournament.playedAt,
          period: period.period,
          opponentId: winner.playerId,
          opponentName: winner.name,
          outcome: "loss",
          change: -(match.loserPoints ?? match.points),
          setScore: setScore ? [setScore[1], setScore[0]] : null,
        });
      }
    }
  }
  return {
    clubId: meta.clubId,
    alias: meta.alias,
    name: meta.name,
    createdAt: meta.createdAt,
    savedNames,
    players,
    playerDetails,
    tournaments,
  };
}

function normalizeTournament(payload, tournamentId, existing = {}) {
  const name = String(payload.name || "").trim().slice(0, 80);
  if (!name) throw new Error("Tävlingen måste ha ett namn");
  const playedAt = String(payload.playedAt || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(playedAt) ||
      Number.isNaN(new Date(`${playedAt}T00:00:00Z`).getTime())) {
    throw new Error("Ogiltigt speldatum");
  }
  const type = payload.type || "normal";
  if (!["normal", "championship"].includes(type)) throw new Error("Ogiltig tävlingstyp");
  const status = payload.status || existing.status || "draft";
  if (!["draft", "finalized"].includes(status)) throw new Error("Ogiltig tävlingsstatus");
  const timestamp = now();
  const state = structuredClone(payload.state || {});
  const matches = structuredClone(payload.matches || []);
  const knownMatchIds = new Set(matches.map(match => match.matchId));
  const playerByLocalId = Object.fromEntries(
    (state.players || []).map(player => [String(player.id), player]),
  );
  for (const [key, result] of Object.entries(state.results || {})) {
    const sets = Array.isArray(result?.[0])
      ? result.reduce(([a, b], set) => [
          a + (set[0] > set[1] ? 1 : 0),
          b + (set[1] > set[0] ? 1 : 0),
        ], [0, 0])
      : result;
    const matchId = `pool:${key}`;
    if (!sets || sets[0] !== sets[1] || knownMatchIds.has(matchId)) continue;
    const [a, b] = key.split("_");
    const playerA = playerByLocalId[a], playerB = playerByLocalId[b];
    if (!playerA?.clubPlayerId || !playerB?.clubPlayerId) continue;
    matches.push({
      matchId,
      playerAId: playerA.clubPlayerId,
      playerBId: playerB.clubPlayerId,
      draw: true,
      ranked: false,
      setScore: sets,
    });
  }
  return {
    tournamentId,
    sourceTournamentId: String(
      payload.sourceTournamentId || state.importSourceId ||
      existing.sourceTournamentId || "",
    ).trim().slice(0, 120) || undefined,
    name,
    playedAt,
    type,
    status,
    state,
    participants: structuredClone(payload.participants || []),
    matches,
    createdAt: existing.createdAt || timestamp,
    updatedAt: timestamp,
  };
}

function matchingImportedTournament(tournaments, payload) {
  const sourceTournamentId = String(
    payload.sourceTournamentId || payload.state?.importSourceId || "",
  ).trim();
  if (sourceTournamentId) {
    const exact = tournaments.find(tournament =>
      String(tournament.sourceTournamentId || tournament.state?.importSourceId || "") ===
      sourceTournamentId);
    if (exact) return exact;
  }
  // Imports created before sourceTournamentId was stored still have stable
  // external match IDs. Any overlap identifies the same source tournament.
  const incomingIds = new Set((payload.matches || [])
    .map(match => String(match.matchId || ""))
    .filter(matchId => matchId.startsWith("import:")));
  if (!incomingIds.size) return null;
  return tournaments.find(tournament =>
    (tournament.matches || []).some(match =>
      incomingIds.has(String(match.matchId || "")))) || null;
}

async function batchWrite(requests) {
  for (let index = 0; index < requests.length; index += 25) {
    let pending = requests.slice(index, index + 25);
    do {
      const result = await db.send(new BatchWriteCommand({
        RequestItems: {[TABLE_NAME]: pending},
      }));
      pending = result.UnprocessedItems?.[TABLE_NAME] || [];
    } while (pending.length);
  }
}

function rankingForTournaments(tournaments) {
  const players = {};
  for (const tournament of tournaments) {
    for (const participant of tournament.participants || []) {
      const playerId = String(participant.playerId || "");
      const name = String(participant.name || "").trim().slice(0, 80);
      if (playerId && name) players[playerId] = name;
    }
  }
  return calculateRanking(players, tournaments);
}

async function persistRankings(clubId, tournaments) {
  const ranking = rankingForTournaments(tournaments);
  const currentItems = await queryClub(clubId);
  const oldKeys = new Set(
    currentItems.filter(item => item.SK.startsWith("PLAYER#")).map(item => item.SK),
  );
  const newKeys = new Set(ranking.players.map(player => `PLAYER#${player.playerId}`));
  const requests = [];
  for (const key of oldKeys) {
    if (!newKeys.has(key)) {
      requests.push({DeleteRequest: {Key: {PK: clubPk(clubId), SK: key}}});
    }
  }
  for (const player of ranking.players) {
    requests.push({PutRequest: {Item: {
      PK: clubPk(clubId),
      SK: `PLAYER#${player.playerId}`,
      ...player,
      updatedAt: now(),
    }}});
  }
  await batchWrite(requests);
  return ranking;
}

async function saveTournament(clubId, payload, requestedId) {
  let tournamentId = requestedId;
  if (!tournamentId) {
    const tournaments = (await queryClub(clubId))
      .filter(item => item.SK.startsWith("TOURNAMENT#"))
      .map(withoutKeys);
    tournamentId = matchingImportedTournament(tournaments, payload)?.tournamentId ||
      crypto.randomUUID().replaceAll("-", "");
  }
  const key = {PK: clubPk(clubId), SK: `TOURNAMENT#${tournamentId}`};
  const {Item: existing} = await db.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: key,
    ConsistentRead: true,
  }));
  const tournament = normalizeTournament(payload, tournamentId, existing);
  const put = {TableName: TABLE_NAME, Item: {...key, ...tournament}};
  if (requestedId && payload.expectedUpdatedAt) {
    put.ConditionExpression = "updatedAt = :expectedUpdatedAt";
    put.ExpressionAttributeValues = {":expectedUpdatedAt": payload.expectedUpdatedAt};
  }
  await db.send(new PutCommand(put));
  const tournaments = (await queryClub(clubId))
    .filter(item => item.SK.startsWith("TOURNAMENT#"))
    .map(withoutKeys);
  return {tournament, ranking: await persistRankings(clubId, tournaments)};
}

export async function handler(event) {
  try {
    const method = event.httpMethod || "";
    if (method === "OPTIONS") return response(204);
    const resource = event.resource || "";
    const params = event.pathParameters || {};

    if (resource === "/clubs" && method === "POST") {
      const input = bodyOf(event);
      const name = String(input.name || "").trim().slice(0, 80);
      const requestedAlias = String(input.alias || "").trim().toLowerCase();
      const spectatorPassword = String(input.spectatorPassword || "").slice(0, 128);
      if (!name) return response(400, {message: "Klubben måste ha ett namn"});
      if (requestedAlias && !validAlias(requestedAlias)) return response(400, {
        message: "Alias måste vara 2–32 tecken och bara innehålla a–z, 0–9 och bindestreck",
      });
      const clubId = crypto.randomUUID().replaceAll("-", "");
      const token = crypto.randomBytes(32).toString("base64url");
      const baseAlias = requestedAlias || aliasFromName(name);
      let alias;
      for (let attempt = 0; attempt < 100; attempt++) {
        const candidate = aliasVariation(baseAlias, attempt);
        try {
          await db.send(new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: TABLE_NAME,
                  Item: {
                    PK: aliasPk(candidate), SK: "META", clubId,
                    alias: candidate, createdAt: now(),
                  },
                  ConditionExpression: "attribute_not_exists(PK)",
                },
              },
              {
                Put: {
                  TableName: TABLE_NAME,
                  Item: {
                    PK: clubPk(clubId),
                    SK: "META",
                    clubId,
                    alias: candidate,
                    name,
                    tokenHash: tokenHash(token),
                    spectatorPasswordHash: spectatorPassword
                      ? tokenHash(spectatorPassword)
                      : undefined,
                    savedNames: [],
                    createdAt: now(),
                  },
                  ConditionExpression: "attribute_not_exists(PK)",
                },
              },
            ],
          }));
          alias = candidate;
          break;
        } catch (error) {
          if (error.name !== "TransactionCanceledException") throw error;
        }
      }
      if (!alias) {
        const suffix = crypto.randomBytes(4).toString("hex");
        alias = baseAlias.slice(0, 23).replace(/-+$/g, "") + "-" + suffix;
        await db.send(new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: TABLE_NAME,
                Item: {PK: aliasPk(alias), SK: "META", clubId, alias, createdAt: now()},
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Put: {
                TableName: TABLE_NAME,
                Item: {
                  PK: clubPk(clubId), SK: "META", clubId, alias, name,
                  tokenHash: tokenHash(token),
                  spectatorPasswordHash: spectatorPassword
                    ? tokenHash(spectatorPassword)
                    : undefined,
                  savedNames: [], createdAt: now(),
                },
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
          ],
        }));
      }
      return response(201, {clubId, alias, accessToken: token, name});
    }

    const requestedClubId = params.clubId || "";
    const clubId = await resolveClubId(requestedClubId);
    if (!clubId) return response(404, {message: "Klubben hittades inte"});
    if (resource === "/clubs/{clubId}/tournaments/{tournamentId}/public" && method === "GET") {
      const [{Item: club}, {Item: tournament}] = await Promise.all([
        db.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {PK: clubPk(clubId), SK: "META"},
          ConsistentRead: true,
          ProjectionExpression: "clubId, #alias, #name, spectatorPasswordHash",
          ExpressionAttributeNames: {"#alias": "alias", "#name": "name"},
        })),
        db.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {
            PK: clubPk(clubId),
            SK: `TOURNAMENT#${params.tournamentId}`,
          },
          ConsistentRead: true,
        })),
      ]);
      if (!club || !tournament) return response(404, {message: "Tävlingen hittades inte"});
      if (!spectatorPasswordAccepted(event, club)) {
        return response(401, {
          message: "Ange klubbens åskådarlösenord",
          requiresPassword: true,
        });
      }
      const publicData = withoutKeys(tournament);
      return response(200, {
        club: {clubId: club.clubId, alias: club.alias, name: club.name},
        tournament: publicData,
      });
    }

    const authorization = await authorize(event, clubId, requestedClubId);
    if (authorization === PASSWORD_REQUIRED) {
      return response(401, {
        message: "Ange klubbens åskådarlösenord",
        requiresPassword: true,
      });
    }
    if (!authorization) {
      return response(401, {message: "Ogiltig klubblänk"});
    }

    if (resource === "/clubs/{clubId}/tournaments/preview-ranking" && method === "POST") {
      const items = await queryClub(clubId);
      const tournaments = items
        .filter(item => item.SK.startsWith("TOURNAMENT#"))
        .map(withoutKeys);
      const preview = normalizeTournament(
        bodyOf(event), `preview-${crypto.randomUUID().replaceAll("-", "")}`,
      );
      const replaced = matchingImportedTournament(tournaments, bodyOf(event));
      const proposed = rankingForTournaments([
        ...tournaments.filter(tournament =>
          tournament.tournamentId !== replaced?.tournamentId),
        preview,
      ]);
      const currentRatings = Object.fromEntries(
        items.filter(item => item.SK.startsWith("PLAYER#"))
          .map(player => [player.playerId, Number(player.rating) || START_RATING]),
      );
      return response(200, {
        replacesTournamentId: replaced?.tournamentId || null,
        replacesTournamentName: replaced?.name || null,
        players: proposed.players.map(player => ({
          playerId: player.playerId,
          name: player.name,
          currentRating: currentRatings[player.playerId] ?? START_RATING,
          proposedRating: player.rating,
          change: player.rating - (currentRatings[player.playerId] ?? START_RATING),
        })),
      });
    }

    if (resource === "/clubs/{clubId}" && method === "GET") {
      return response(200, publicClub(await queryClub(clubId)));
    }
    if (resource === "/clubs/{clubId}/saved-names" && method === "PUT") {
      const input = bodyOf(event).names;
      if (!Array.isArray(input)) return response(400, {message: "Ogiltig namnlista"});
      const seen = new Set();
      const names = [];
      for (const value of input) {
        const name = String(value).replace(/[\t\r\n]+/g, " ").trim().slice(0, 80);
        const key = name.toLocaleLowerCase("sv");
        if (name && !seen.has(key)) {
          seen.add(key);
          names.push(name);
        }
      }
      names.sort((a, b) => a.localeCompare(b, "sv", {sensitivity: "base"}));
      await db.send(new UpdateCommand({
        TableName: TABLE_NAME,
        Key: {PK: clubPk(clubId), SK: "META"},
        UpdateExpression: "SET savedNames = :names, updatedAt = :updatedAt",
        ExpressionAttributeValues: {":names": names, ":updatedAt": now()},
      }));
      return response(200, {savedNames: names});
    }
    if (resource === "/clubs/{clubId}/tournaments" && method === "POST") {
      return response(201, await saveTournament(clubId, bodyOf(event)));
    }
    if (resource === "/clubs/{clubId}/tournaments/{tournamentId}" && method === "PUT") {
      return response(200, await saveTournament(clubId, bodyOf(event), params.tournamentId));
    }
    if (resource === "/clubs/{clubId}/tournaments/{tournamentId}" && method === "DELETE") {
      await db.send(new DeleteCommand({
        TableName: TABLE_NAME,
        Key: {PK: clubPk(clubId), SK: `TOURNAMENT#${params.tournamentId}`},
      }));
      const tournaments = (await queryClub(clubId))
        .filter(item => item.SK.startsWith("TOURNAMENT#"))
        .map(withoutKeys);
      return response(200, {ranking: await persistRankings(clubId, tournaments)});
    }
    return response(404, {message: "Hittades inte"});
  } catch (error) {
    if (error.name === "TransactionCanceledException") {
      return response(409, {message: "Aliaset används redan av en annan klubb"});
    }
    if (error.name === "ConditionalCheckFailedException") {
      return response(409, {
        message: "Tävlingen har ändrats på en annan enhet. Ladda om sidan innan du sparar igen.",
      });
    }
    if (error instanceof SyntaxError || [
      "Tävlingen måste ha ett namn",
      "Ogiltigt speldatum",
      "Ogiltig tävlingstyp",
      "Ogiltig tävlingsstatus",
      "Ogiltig namnlista",
    ].includes(error.message)) {
      return response(400, {message: error.message});
    }
    console.error(error);
    return response(500, {message: "Internt serverfel"});
  }
}
