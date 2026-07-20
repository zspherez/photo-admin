export const CONTACT_RESEARCH_VIEWS = ["all", "skipped"] as const;
export type ContactResearchView = (typeof CONTACT_RESEARCH_VIEWS)[number];

export function parseContactResearchView(
  value: string | string[] | undefined
): ContactResearchView {
  const first = Array.isArray(value) ? value[0] : value;
  return first === "skipped" ? "skipped" : "all";
}

export function contactResearchHref(
  view: ContactResearchView,
  values: Record<string, string> = {}
): string {
  const params = new URLSearchParams(values);
  if (view !== "all") params.set("view", view);
  const query = params.toString();
  return query ? `/research?${query}` : "/research";
}

export function contactResearchViewFromForm(
  formData: FormData
): ContactResearchView {
  return parseContactResearchView(String(formData.get("view") ?? ""));
}
