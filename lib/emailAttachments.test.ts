import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { db } from "./db";
import { EMAIL_ATTACHMENT_MAX_BYTES, emailAttachmentError } from "./emailAttachmentPolicy";
import { readAndStoreEmailAttachments, readAttachmentManifest, loadEmailAttachmentBlobs } from "./emailAttachments";
import { hashAttachmentContent } from "./resend";

test("attachment validation bounds file count, aggregate bytes, paths and extensions", () => {
  assert.equal(emailAttachmentError([{ name: "portfolio.PDF", size: EMAIL_ATTACHMENT_MAX_BYTES }]), null);
  for (const files of [
    [{ name: "x.pdf", size: EMAIL_ATTACHMENT_MAX_BYTES + 1 }],
    [{ name: "a.pdf", size: 2 * 1024 * 1024 }, { name: "b.pdf", size: 2 * 1024 * 1024 }],
    Array.from({ length: 11 }, () => ({ name: "x.pdf", size: 1 })),
    [{ name: "x.pdf", size: 0 }],
    [{ name: "../x.pdf", size: 1 }],
    [{ name: "x\r\n.pdf", size: 1 }],
    [{ name: "x.exe", size: 1 }],
    [{ name: "x.constructor", size: 1 }],
    [{ name: "pdf", size: 1 }],
  ]) assert.ok(emailAttachmentError(files));
});

test("uploads retain exact bytes with a content hash and reject invalid input before storage", async (t) => {
  const blobs = new Map<string, { sha256: string; content: Uint8Array<ArrayBuffer>; byteLength: number }>();
  const model = db.outreachAttachmentBlob;
  const originalUpsert = model.upsert;
  const originalFindMany = model.findMany;
  Object.defineProperty(model, "upsert", {
    configurable: true, writable: true,
    value: async ({ create }: { create: { sha256: string; content: Uint8Array<ArrayBuffer>; byteLength: number } }) => {
      blobs.set(create.sha256, blobs.get(create.sha256) ?? create);
      return blobs.get(create.sha256);
    },
  });
  Object.defineProperty(model, "findMany", { configurable: true, writable: true, value: async () => [...blobs.values()] });
  t.after(() => {
    Object.defineProperty(model, "upsert", { configurable: true, writable: true, value: originalUpsert });
    Object.defineProperty(model, "findMany", { configurable: true, writable: true, value: originalFindMany });
  });
  const data = new FormData();
  data.append("attachments", new File(["%PDF-demo"], "portfolio.pdf", { type: "text/plain" }));
  const result = await readAndStoreEmailAttachments(data);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.attachments[0].contentType, "application/pdf");
  const loaded = await loadEmailAttachmentBlobs(result.attachments);
  assert.equal(new TextDecoder().decode(loaded[0].content), "%PDF-demo");
  assert.equal(result.attachments[0].contentSha256, hashAttachmentContent(loaded[0].content));
  await readAndStoreEmailAttachments(data);
  assert.equal(blobs.size, 1);
  const invalid = new FormData();
  invalid.append("attachments", "pretend-file");
  assert.equal((await readAndStoreEmailAttachments(invalid)).ok, false);
  invalid.set("attachments", new File(["bad"], "x.exe"));
  assert.equal((await readAndStoreEmailAttachments(invalid)).ok, false);
  assert.equal(blobs.size, 1);
  loaded[0].content[0] = 0;
  await assert.rejects(loadEmailAttachmentBlobs(result.attachments), /integrity/);
  blobs.clear();
  await assert.rejects(loadEmailAttachmentBlobs(result.attachments), /missing/);
});

test("attachment metadata is parsed fail-closed", () => {
  assert.deepEqual(readAttachmentManifest(undefined), []);
  assert.throws(() => readAttachmentManifest(null), /invalid/);
  assert.throws(() => readAttachmentManifest([{ filename: "a.pdf" }]), /invalid/);
  const attachments = [{
    filename: "portfolio.pdf", contentSha256: "a".repeat(64),
    byteLength: 8, contentType: "application/pdf", contentId: null,
  }];
  assert.deepEqual(readAttachmentManifest(attachments), attachments);
});

test("only custom-email surfaces wire upload controls and immutable attachment manifests", () => {
  const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const outreach = source("./sendOutreach.ts");
  assert.doesNotMatch(outreach, /attachmentManifestJson|readAttachmentManifest/);
  const arbitrary = source("./sendArbitraryEmail.ts");
  assert.match(arbitrary, /attachments: readAttachmentManifest\(row\.attachmentManifest\)/);
  assert.equal((arbitrary.match(/loadEmailAttachmentBlobs\(request\.attachments, tx\)/g) ?? []).length, 2);
  const action = source("../app/emails/actions.ts");
  assert.ok(action.indexOf("await requireServerActionAuth") < action.indexOf("await readAndStoreEmailAttachments"));
  assert.doesNotMatch(source("../app/dashboard/customize/[showId]/[contactId]/customize-form.tsx"), /EmailAttachmentsInput/);
  assert.match(source("../app/emails/new/compose-email-form.tsx"), /EmailAttachmentsInput/);
});
