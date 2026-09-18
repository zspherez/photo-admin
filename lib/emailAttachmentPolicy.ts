export const EMAIL_ATTACHMENT_MAX_FILES = 10;
export const EMAIL_ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;
export const EMAIL_ATTACHMENT_TYPES: Readonly<Record<string, string>> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain",
  csv: "text/csv",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
};
export const EMAIL_ATTACHMENT_ACCEPT = Object.keys(EMAIL_ATTACHMENT_TYPES)
  .map((extension) => `.${extension}`).join(",");

export function emailAttachmentError(files: readonly { name: string; size: number }[]): string | null {
  if (files.length > EMAIL_ATTACHMENT_MAX_FILES) return "Attach at most 10 files.";
  if (files.reduce((sum, file) => sum + file.size, 0) > EMAIL_ATTACHMENT_MAX_BYTES) {
    return "Attachments must total 3 MB or less.";
  }
  for (const file of files) {
    if (!file.name.trim() || file.name.length > 180 || /[\\/\u0000-\u001f\u007f]/.test(file.name)) {
      return "Attachment filenames must be 1-180 characters without paths or control characters.";
    }
    if (!Number.isSafeInteger(file.size) || file.size <= 0) return `${file.name}: empty files are not supported.`;
    if (!file.name.includes(".") || !Object.hasOwn(EMAIL_ATTACHMENT_TYPES, file.name.split(".").pop()?.toLowerCase() ?? "")) {
      return `${file.name}: unsupported file type. Use PDF, images, text/CSV, Office documents, or ZIP.`;
    }
  }
  return null;
}
