import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { hashAttachmentContent, type ResendAttachmentBlob, type ResendAttachmentSnapshot } from "@/lib/resend";
import { emailAttachmentError, EMAIL_ATTACHMENT_TYPES } from "@/lib/emailAttachmentPolicy";

export function readAttachmentManifest(value: unknown): ResendAttachmentSnapshot[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("Stored attachment manifest is invalid");
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" ||
      !("filename" in entry) || typeof entry.filename !== "string" ||
      !("contentSha256" in entry) || typeof entry.contentSha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.contentSha256) ||
      !("byteLength" in entry) || typeof entry.byteLength !== "number" || !Number.isSafeInteger(entry.byteLength) || entry.byteLength < 0 ||
      !("contentType" in entry) || (entry.contentType !== null && typeof entry.contentType !== "string") ||
      !("contentId" in entry) || (entry.contentId !== null && typeof entry.contentId !== "string")) {
      throw new Error("Stored attachment manifest is invalid");
    }
    return { filename: entry.filename, contentSha256: entry.contentSha256, byteLength: entry.byteLength,
      contentType: entry.contentType, contentId: entry.contentId };
  });
}

export function attachmentManifestJson(attachments: readonly ResendAttachmentSnapshot[] = []): Prisma.InputJsonValue {
  return attachments.map((attachment) => ({ ...attachment }));
}

export async function readAndStoreEmailAttachments(formData: FormData): Promise<
  { ok: true; attachments: ResendAttachmentSnapshot[] } | { ok: false; error: string }
> {
  const values = formData.getAll("attachments");
  if (values.some((value) => typeof value === "string")) return { ok: false, error: "Attachments must be uploaded files." };
  const files = values.filter((value): value is File => typeof value !== "string")
    .filter((file) => file.name !== "" || file.size !== 0);
  const error = emailAttachmentError(files);
  if (error) return { ok: false, error };
  const attachments: ResendAttachmentSnapshot[] = [];
  for (const file of files) {
    const content = new Uint8Array(await file.arrayBuffer());
    const sha256 = hashAttachmentContent(content);
    const blob = await db.outreachAttachmentBlob.upsert({
      where: { sha256 },
      update: {},
      create: { sha256, byteLength: content.byteLength, content },
    });
    if (blob.byteLength !== content.byteLength || hashAttachmentContent(blob.content) !== sha256) {
      throw new Error("Stored attachment blob failed its integrity check");
    }
    attachments.push({
      filename: file.name,
      contentSha256: sha256,
      byteLength: content.byteLength,
      contentType: EMAIL_ATTACHMENT_TYPES[file.name.split(".").pop()!.toLowerCase()],
      contentId: null,
    });
  }
  return { ok: true, attachments };
}

export async function loadEmailAttachmentBlobs(
  attachments: readonly ResendAttachmentSnapshot[],
  database: Pick<Prisma.TransactionClient, "outreachAttachmentBlob"> = db,
): Promise<ResendAttachmentBlob[]> {
  if (!attachments.length) return [];
  const blobs = await database.outreachAttachmentBlob.findMany({
    where: { sha256: { in: attachments.map((attachment) => attachment.contentSha256) } },
  });
  for (const attachment of attachments) {
    const blob = blobs.find((candidate) => candidate.sha256 === attachment.contentSha256);
    if (!blob || blob.byteLength !== attachment.byteLength ||
      blob.content.byteLength !== attachment.byteLength || hashAttachmentContent(blob.content) !== attachment.contentSha256) {
      throw new Error("Stored attachment is missing or failed its integrity check");
    }
  }
  return blobs;
}
