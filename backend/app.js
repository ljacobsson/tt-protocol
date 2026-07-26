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
const tokenHash = token => crypto.createHash("sha256").update(token).digest("hex");

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": ORIGIN,
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
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

async function authorize(event, clubId) {
  const headers = event.headers || {};
  const authorization = headers.Authorization || headers.authorization || "";
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const {Item: meta} = await db.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: {PK: clubPk(clubId), SK: "META"},
    ConsistentRead: true,
  }));
  if (!meta || !token) return null;
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
  return {
    clubId: meta.clubId,
    name: meta.name,
    createdAt: meta.createdAt,
    savedNames,
    players,
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
  return {
    tournamentId,
    name,
    playedAt,
    type,
    status,
    state: structuredClone(payload.state || {}),
    participants: structuredClone(payload.participants || []),
    matches: structuredClone(payload.matches || []),
    createdAt: existing.createdAt || timestamp,
    updatedAt: timestamp,
  };
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

async function persistRankings(clubId, tournaments) {
  const players = {};
  for (const tournament of tournaments) {
    for (const participant of tournament.participants || []) {
      const playerId = String(participant.playerId || "");
      const name = String(participant.name || "").trim().slice(0, 80);
      if (playerId && name) players[playerId] = name;
    }
  }

  const ranking = calculateRanking(players, tournaments);
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
  const tournamentId = requestedId || crypto.randomUUID().replaceAll("-", "");
  const key = {PK: clubPk(clubId), SK: `TOURNAMENT#${tournamentId}`};
  const {Item: existing} = await db.send(new GetCommand({
    TableName: TABLE_NAME,
    Key: key,
    ConsistentRead: true,
  }));
  const tournament = normalizeTournament(payload, tournamentId, existing);
  await db.send(new PutCommand({TableName: TABLE_NAME, Item: {...key, ...tournament}}));
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
      const name = String(bodyOf(event).name || "").trim().slice(0, 80);
      if (!name) return response(400, {message: "Klubben måste ha ett namn"});
      const clubId = crypto.randomUUID().replaceAll("-", "");
      const token = crypto.randomBytes(32).toString("base64url");
      await db.send(new PutCommand({
        TableName: TABLE_NAME,
        Item: {
          PK: clubPk(clubId),
          SK: "META",
          clubId,
          name,
          tokenHash: tokenHash(token),
          savedNames: [],
          createdAt: now(),
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }));
      return response(201, {clubId, accessToken: token, name});
    }

    const clubId = params.clubId || "";
    if (resource === "/clubs/{clubId}/tournaments/{tournamentId}/public" && method === "GET") {
      const [{Item: club}, {Item: tournament}] = await Promise.all([
        db.send(new GetCommand({
          TableName: TABLE_NAME,
          Key: {PK: clubPk(clubId), SK: "META"},
          ConsistentRead: true,
          ProjectionExpression: "clubId, #name",
          ExpressionAttributeNames: {"#name": "name"},
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
      const publicData = withoutKeys(tournament);
      return response(200, {
        club: {clubId: club.clubId, name: club.name},
        tournament: publicData,
      });
    }

    if (!await authorize(event, clubId)) {
      return response(401, {message: "Ogiltig klubblänk"});
    }

    if (resource === "/clubs/{clubId}" && method === "GET") {
      return response(200, publicClub(await queryClub(clubId)));
    }
    if (resource === "/clubs/{clubId}/saved-names" && method === "PUT") {
      const input = bodyOf(event).names;
      if (!Array.isArray(input)) return response(400, {message: "Ogiltig namnlista"});
      const seen = new Set();
      const names = [];
      for (const value of input.slice(0, 200)) {
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
