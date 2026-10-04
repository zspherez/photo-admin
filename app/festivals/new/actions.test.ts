import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("./actions.ts", import.meta.url),
  "utf8"
);
const form = readFileSync(
  new URL("./festival-form.tsx", import.meta.url),
  "utf8",
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
  const manualOwnership = source.indexOf(
    "manuallyAdded: true",
    lineupCreate
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
  assert.ok(manualOwnership > lineupCreate);
  assert.ok(transactionEnd > lineupCreate);
});

test("confirmed duplicate artists merge inside the festival transaction before lineup insertion", () => {
  const transactionStart = source.indexOf("return await db.$transaction(");
  const merge = source.indexOf("await mergeArtistsInTransaction(", transactionStart);
  const artistCreate = source.indexOf("await tx.artist.create(", transactionStart);
  const showCreate = source.indexOf("await tx.show.create(", transactionStart);
  assert.ok(merge > transactionStart);
  assert.ok(artistCreate > merge);
  assert.ok(showCreate > artistCreate);
  assert.match(source, /confirmedMerges\.has\(entry\.selectionKey\)/);
  assert.match(source, /error instanceof FestivalMergeError/);
  assert.match(source, /timeout: 120_000/);
  assert.match(form, /name=\{`mergeChoice:\$\{ambiguity\.selectionKey\}`\}/);
  assert.match(form, /value="MERGE"/);
  assert.match(form, /defaultChecked=\{ambiguity\.mergeConfirmed\}/);
  assert.match(form, /pathname: "\/artists\/merge"/);
});
