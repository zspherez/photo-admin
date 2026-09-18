"use client";

import { EMAIL_ATTACHMENT_ACCEPT, emailAttachmentError } from "@/lib/emailAttachmentPolicy";

export function EmailAttachmentsInput({
  files, onChange, disabled = false,
}: {
  files: File[];
  onChange: (files: File[]) => void;
  disabled?: boolean;
}) {
  const error = emailAttachmentError(files);
  return (
    <fieldset disabled={disabled} className="space-y-2">
      <legend className="text-sm font-medium">Attachments</legend>
      <p className="text-xs text-zinc-500">Up to 10 files, 3 MB total. PDF, JPG/PNG/GIF/WebP, TXT/CSV, DOCX/XLSX/PPTX, or ZIP. Files are saved with scheduled emails.</p>
      <input type="file" multiple accept={EMAIL_ATTACHMENT_ACCEPT} aria-label="Add attachments"
        className="block w-full text-sm"
        onChange={(event) => {
          onChange([...files, ...Array.from(event.target.files ?? [])]);
          event.target.value = "";
        }} />
      <ul className="space-y-1 text-sm">
        {files.map((file, index) => (
          <li key={`${index}:${file.name}`} className="flex items-center justify-between gap-2">
            <span className="break-all">{file.name} ({Math.ceil(file.size / 1024)} KB)</span>
            <button type="button" className="text-xs underline" aria-label={`Remove ${file.name}`}
              onClick={() => onChange(files.filter((_, i) => i !== index))}>Remove</button>
          </li>
        ))}
      </ul>
      {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    </fieldset>
  );
}
