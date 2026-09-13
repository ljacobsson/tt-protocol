import assert from "node:assert/strict";
import test from "node:test";

import {collectPages} from "../backend/pagination.js";

test("club queries include every DynamoDB page", async () => {
  const startKeys = [];
  const lastKey = {PK: "CLUB#bbtk", SK: "TOURNAMENT#1"};

  const items = await collectPages(async startKey => {
    startKeys.push(startKey);
    if (!startKey) {
      return {
        Items: [{SK: "META"}, {SK: "TOURNAMENT#1"}],
        LastEvaluatedKey: lastKey,
      };
    }
    return {Items: [{SK: "TOURNAMENT#2"}]};
  });

  assert.deepEqual(items.map(item => item.SK), [
    "META", "TOURNAMENT#1", "TOURNAMENT#2",
  ]);
  assert.equal(startKeys[0], undefined);
  assert.deepEqual(startKeys[1], lastKey);
});
