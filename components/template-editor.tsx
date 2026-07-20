"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { useEffect, useRef, useState } from "react";
import { normalizeArbitraryEmailPreviewAction } from "@/app/emails/actions";
import { insertTextAtSelection } from "./template-editor-utils";

type View = "visual" | "html" | "preview";

interface Props {
  initialSubject: string;
  initialHtml: string;
  variables: string[];
  disabled?: boolean;
  subjectValue?: string;
  htmlValue?: string;
  onSubjectChange?: (value: string) => void;
  onHtmlChange?: (value: string) => void;
  previewNormalization?: "arbitrary-email";
}

const EMPTY_PREVIEW =
  '<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body></body></html>';
const ARBITRARY_UTM_FIELDS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_content",
  "utm_term",
] as const;

export function TemplateEditor({
  initialSubject,
  initialHtml,
  variables,
  disabled = false,
  subjectValue,
  htmlValue,
  onSubjectChange,
  onHtmlChange,
  previewNormalization,
}: Props) {
  const [internalSubject, setInternalSubject] = useState(initialSubject);
  const [internalHtml, setInternalHtml] = useState(initialHtml);
  const subject = subjectValue ?? internalSubject;
  const html = htmlValue ?? internalHtml;
  const [view, setView] = useState<View>("visual");
  const [normalizedPreview, setNormalizedPreview] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const htmlTextareaRef = useRef<HTMLTextAreaElement>(null);
  const onHtmlChangeRef = useRef(onHtmlChange);
  const containerRef = useRef<HTMLDivElement>(null);
  const previewRequestRef = useRef(0);

  useEffect(() => {
    onHtmlChangeRef.current = onHtmlChange;
  }, [onHtmlChange]);

  const setSubject = (value: string) => {
    if (onSubjectChange) onSubjectChange(value);
    else setInternalSubject(value);
  };
  const setHtml = (value: string) => {
    if (onHtmlChange) onHtmlChange(value);
    else setInternalHtml(value);
  };

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      Link.configure({ openOnClick: false, autolink: true }),
    ],
    content: htmlValue ?? initialHtml,
    immediatelyRender: false,
    editable: !disabled,
    onUpdate: ({ editor }) => {
      const value = editor.getHTML();
      if (onHtmlChangeRef.current) onHtmlChangeRef.current(value);
      else setInternalHtml(value);
    },
    editorProps: {
      attributes: {
        "aria-label": "Email template visual editor",
        class:
          "prose prose-sm max-w-none min-h-[300px] rounded-md border border-zinc-300 bg-white px-3 py-2 dark:prose-invert dark:border-zinc-700 dark:bg-zinc-900 focus:outline-none focus:ring-1 focus:ring-emerald-500",
      },
    },
  });

  // When switching back into visual mode, push the HTML source into the editor.
  useEffect(() => {
    if (view === "visual" && editor && editor.getHTML() !== html) {
      editor.commands.setContent(html, { emitUpdate: false });
    }
  }, [view, editor, html]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

  const showPreview = async () => {
    setView("preview");
    if (previewNormalization !== "arbitrary-email") return;
    const request = previewRequestRef.current + 1;
    previewRequestRef.current = request;
    setPreviewLoading(true);
    setPreviewError(null);
    setNormalizedPreview(null);
    try {
      const form = containerRef.current?.closest("form");
      const formData = form ? new FormData(form) : null;
      const utm = Object.fromEntries(
        ARBITRARY_UTM_FIELDS.map((name) => [
          name,
          String(formData?.get(name) ?? ""),
        ]),
      );
      const result = await normalizeArbitraryEmailPreviewAction(html, utm);
      if (previewRequestRef.current !== request) return;
      if (result.ok) {
        setNormalizedPreview(result.content.html);
      } else {
        setNormalizedPreview(null);
        setPreviewError(result.error);
      }
    } catch {
      if (previewRequestRef.current !== request) return;
      setNormalizedPreview(null);
      setPreviewError("Unable to normalize the email preview");
    } finally {
      if (previewRequestRef.current === request) setPreviewLoading(false);
    }
  };

  const insertVar = (v: string) => {
    const insertion = `{{${v}}}`;
    if (view === "html") {
      const textarea = htmlTextareaRef.current;
      const result = insertTextAtSelection(
        html,
        insertion,
        textarea?.selectionStart ?? html.length,
        textarea?.selectionEnd ?? html.length,
      );
      setHtml(result.value);
      requestAnimationFrame(() => {
        const current = htmlTextareaRef.current;
        current?.focus();
        current?.setSelectionRange(result.cursor, result.cursor);
      });
      return;
    }
    if (view === "visual" && editor) {
      editor.chain().focus().insertContent(insertion).run();
    }
  };

  const setLink = () => {
    if (!editor) return;
    const prev = editor.getAttributes("link").href as string | undefined;
    const url = window.prompt("URL (leave blank to remove)", prev ?? "https://");
    if (url === null) return;
    if (url === "") {
      editor.chain().focus().unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  return (
    <div ref={containerRef} className="space-y-4">
      <input type="hidden" name="subject" value={subject} />
      <input type="hidden" name="html" value={html} />

      <div>
        <label htmlFor="subject-input" className="text-sm font-medium">Subject</label>
        <input
          id="subject-input"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          disabled={disabled}
          className="mt-1 block w-full rounded-md border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
      </div>

      <div
        role="toolbar"
        aria-label="Template editor controls"
        className="flex flex-wrap items-center gap-1 rounded-md border border-zinc-200 p-1 dark:border-zinc-800"
      >
        <Tab active={view === "visual"} onClick={() => setView("visual")}>Visual</Tab>
        <Tab active={view === "html"} onClick={() => setView("html")}>HTML</Tab>
        <Tab active={view === "preview"} onClick={() => void showPreview()}>Preview</Tab>
        <div className="mx-2 h-5 w-px bg-zinc-200 dark:bg-zinc-700" />
        {view === "visual" && editor && (
          <>
            <ToolbarBtn
              active={editor.isActive("bold")}
              disabled={disabled}
              onClick={() => editor.chain().focus().toggleBold().run()}
              title="Bold"
            >
              <b>B</b>
            </ToolbarBtn>
            <ToolbarBtn
              active={editor.isActive("italic")}
              disabled={disabled}
              onClick={() => editor.chain().focus().toggleItalic().run()}
              title="Italic"
            >
              <i>I</i>
            </ToolbarBtn>
            <ToolbarBtn
              active={editor.isActive("strike")}
              disabled={disabled}
              onClick={() => editor.chain().focus().toggleStrike().run()}
              title="Strikethrough"
            >
              <s>S</s>
            </ToolbarBtn>
            <ToolbarBtn
              active={editor.isActive("bulletList")}
              disabled={disabled}
              onClick={() => editor.chain().focus().toggleBulletList().run()}
              title="Bulleted list"
            >
              •
            </ToolbarBtn>
            <ToolbarBtn
              active={editor.isActive("orderedList")}
              disabled={disabled}
              onClick={() => editor.chain().focus().toggleOrderedList().run()}
              title="Numbered list"
            >
              1.
            </ToolbarBtn>
            <ToolbarBtn
              active={editor.isActive("link")}
              disabled={disabled}
              onClick={setLink}
              title="Link"
            >
              🔗
            </ToolbarBtn>
          </>
        )}
        {variables.length > 0 &&
          (view === "html" || (view === "visual" && editor)) && (
          <div className="ml-auto">
            <select
              aria-label="Insert template variable"
              onChange={(e) => {
                const v = e.target.value;
                if (!v) return;
                insertVar(v);
                e.target.value = "";
              }}
              className="rounded border border-zinc-300 px-2 py-0.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
              defaultValue=""
              disabled={disabled}
            >
              <option value="" disabled>Insert variable…</option>
              {variables.map((v) => (
                <option key={v} value={v}>{`{{${v}}}`}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {view === "visual" && <EditorContent editor={editor} />}

      {view === "html" && (
        <textarea
          ref={htmlTextareaRef}
          aria-label="Email template HTML"
          value={html}
          onChange={(e) => setHtml(e.target.value)}
          disabled={disabled}
          rows={20}
          className="block w-full rounded-md border border-zinc-300 bg-white px-3 py-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-900"
        />
      )}

      {view === "preview" && (
        <div className="space-y-2">
          {previewLoading && (
            <p className="text-xs text-zinc-500">Normalizing preview…</p>
          )}
          {previewError && (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
              {previewError}
            </p>
          )}
          <iframe
            title="Email HTML preview"
            sandbox=""
            srcDoc={
              previewNormalization === "arbitrary-email"
                ? normalizedPreview ?? EMPTY_PREVIEW
                : html
            }
            className="min-h-[360px] w-full rounded-md border border-zinc-200 bg-white dark:border-zinc-800"
          />
        </div>
      )}
    </div>
  );
}

function Tab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded px-2.5 py-1 text-xs font-medium ${
        active
          ? "bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900"
          : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
      }`}
    >
      {children}
    </button>
  );
}

function ToolbarBtn({
  active,
  disabled,
  onClick,
  title,
  children,
}: {
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={`rounded px-2 py-1 text-xs ${
        active
          ? "bg-zinc-200 dark:bg-zinc-700"
          : "hover:bg-zinc-100 dark:hover:bg-zinc-800"
      }`}
    >
      {children}
    </button>
  );
}
