import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./actions.ts", import.meta.url),
  "utf8"
);

test("festival action validates before persistence", () => {
  const actionStart = source.indexOf("export async function createFestival");
  const validation = source.indexOf(
    "validateFestivalCreation(values)",
    actionStart
  );
  const invalidReturn = source.indexOf(
    "return errorState(values, validation.message)",
    validation
  );
  const persistence = source.indexOf(
    "await persistFestival(",
    validation
  );

  assert.ok(actionStart >= 0);
  assert.ok(validation > actionStart);
  assert.ok(invalidReturn > validation);
  assert.ok(persistence > invalidReturn);
});

test("festival show, artists, and lineup links are created transactionally", () => {
  const persistenceStart = source.indexOf("async function persistFestival");
  const transactionStart = source.indexOf(
    "return await db.$transaction(",
    persistenceStart
  );
  const artistCreate = source.indexOf(
    "await tx.artist.create(",
    transactionStart
  );
  const showCreate = source.indexOf(
    "await tx.show.create(",
    transactionStart
  );
  const countryPersisted = source.indexOf(
    "countryCode,",
    showCreate
  );
  const geographyPersisted = source.indexOf(
    "festivalNycStatus,",
    showCreate
  );
  const lineupCreate = source.indexOf(
    "await tx.showArtist.createMany(",
    transactionStart
  );
  const transactionEnd = source.indexOf(
    "isolationLevel: Prisma.TransactionIsolationLevel.Serializable",
    transactionStart
  );

  assert.ok(persistenceStart >= 0);
  assert.ok(transactionStart > persistenceStart);
  assert.ok(artistCreate > transactionStart);
  assert.ok(showCreate > artistCreate);
  assert.ok(countryPersisted > showCreate);
  assert.ok(geographyPersisted > countryPersisted);
  assert.ok(lineupCreate > showCreate);
  assert.ok(transactionEnd > lineupCreate);
});
