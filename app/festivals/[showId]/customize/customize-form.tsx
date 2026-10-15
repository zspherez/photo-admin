"use client";

import { useActionState, useRef, useState } from "react";
import { TemplateEditor } from "@/components/template-editor";
import { Button } from "@/components/ui/button";
import {
  previewFestivalTemplateAction,
  type FestivalTemplatePreviewResult,
  type FestivalTemplateSaveState,
} from "./actions";

export function FestivalCustomizeForm({
  showId,
  sampleContactId,
  sampleLabel,
  initialSubject,
  initialHtml,
  variables,
  action,
}: {
  showId: string;
  sampleContactId: string | null;
  sampleLabel: string | null;
  initialSubject: string;
  initialHtml: string;
  variables: string[];
  action: (state: FestivalTemplateSaveState, formData: FormData) => Promise<FestivalTemplateSaveState>;
}) {
  const [subject, setSubject] = useState(initialSubject);
  const [html, setHtml] = useState(initialHtml);
  const [state, formAction, pending] = useActionState(action, { error: null, saved: false });
  const [preview, setPreview] = useState<FestivalTemplatePreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const previewRequest = useRef(0);

  async function showPreview() {
    const request = ++previewRequest.current;
    setPreviewing(true);
    setPreview(null);
    try {
      const result = await previewFestivalTemplateAction(showId, sampleContactId, subject, html);
      if (previewRequest.current === request) setPreview(result);
    } catch {
      if (previewRequest.current === request) {
        setPreview({ ok: false, error: "Unable to preview this festival template" });
      }
    } finally {
      if (previewRequest.current === request) setPreviewing(false);
    }
  }

  function invalidatePreview() {
    previewRequest.current += 1;
    setPreview(null);
    setPreviewing(false);
  }

  return (
    <>
      <form action={formAction}>
        <TemplateEditor
          initialSubject={initialSubject}
          initialHtml={initialHtml}
          subjectValue={subject}
          htmlValue={html}
          onSubjectChange={(value) => { setSubject(value); invalidatePreview(); }}
          onHtmlChange={(value) => { setHtml(value); invalidatePreview(); }}
          variables={variables}
        />
        {state.error && <p role="alert" className="mt-3 text-sm text-red-700">{state.error}</p>}
        {state.saved && !state.error && <p role="status" className="mt-3 text-sm text-emerald-700">Festival template saved.</p>}
        <div className="mt-4 flex flex-wrap gap-3">
          <Button type="submit" variant="primary" disabled={pending}>Save festival template</Button>
          <Button type="button" onClick={() => void showPreview()} disabled={previewing}>
            {previewing ? "Previewing…" : "Preview personalized email"}
          </Button>
        </div>
      </form>
      <section className="mt-8" aria-label="Personalized festival preview">
        <h2 className="text-sm font-semibold">Personalized preview</h2>
        <p className="mt-1 text-xs text-zinc-500">
          {sampleLabel ?? "No sample recipient available."} Preview renders the current draft for one sample; sends render each artist and manager separately.
        </p>
        {preview && (!preview.ok ? (
          <p role="alert" className="mt-3 text-sm text-red-700">{preview.error}</p>
        ) : (
          <div className="mt-3 space-y-2">
            <p className="text-xs font-medium text-zinc-500">Subject</p>
            <p>{preview.subject}</p>
            <p className="text-xs font-medium text-zinc-500">Body</p>
            <iframe title="Personalized festival email preview" sandbox="" srcDoc={preview.html} className="min-h-80 w-full rounded border bg-white" />
          </div>
        ))}
      </section>
    </>
  );
}
