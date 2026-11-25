import { db } from "@/lib/db";
import { formatShowDate } from "@/lib/formatDate";
import {
  applyHtmlTemplate,
  applyTemplate,
  buildVarsForShow,
  COMMON_TEMPLATE_VARS,
  extractVars,
  malformedTemplateVariableTokens,
  normalizeTemplateContent,
  type TemplateContent,
} from "@/lib/template";

export const FESTIVAL_RUN_PITCH_TEMPLATE_NAME = "festival_run_outreach";
export const FESTIVAL_RUN_PITCH_VARIABLES = [
  ...COMMON_TEMPLATE_VARS,
  "run_festivals",
  "run_cities",
  "run_dates",
] as const;

export const DEFAULT_FESTIVAL_RUN_PITCH: TemplateContent = {
  subject: "{{artist}} festival run photo/video coverage",
  htmlBody:
    "<p>Hi there, I wanted to reach out about {{artist}}'s upcoming festivals: {{run_festivals}} ({{run_dates}}). I'm a photographer and videographer specializing in electronic music and would love to discuss coverage across the run.</p>" +
    "<p>I'm happy to tailor deliverables to your needs. You can see examples of my work at <a href=\"{{portfolio_url}}\">{{portfolio_url}}</a>.</p>" +
    "<p>Best,<br>{{sender_name}}<br>{{sender_email}} // {{sender_phone}}</p>",
};

export function validateFestivalRunPitchTemplate(content: TemplateContent): string[] {
  return [
    ...malformedTemplateVariableTokens(content),
    ...extractVars(`${content.subject} ${content.htmlBody}`).filter(
      (variable) => !FESTIVAL_RUN_PITCH_VARIABLES.includes(
        variable as (typeof FESTIVAL_RUN_PITCH_VARIABLES)[number],
      ),
    ),
  ];
}

export async function readFestivalRunPitchTemplate(): Promise<TemplateContent> {
  const saved = await db.emailTemplate.findUnique({
    where: { name: FESTIVAL_RUN_PITCH_TEMPLATE_NAME },
  });
  return saved ? normalizeTemplateContent(saved) : DEFAULT_FESTIVAL_RUN_PITCH;
}

export async function renderFestivalRunPitch(
  template: TemplateContent,
  artistName: string,
  shows: Array<{
    date: Date;
    city: string;
    state: string | null;
    venueName: string;
    eventName: string | null;
    countryCode: string | null;
    countryName: string | null;
  }>,
  readSetting?: Parameters<typeof buildVarsForShow>[1],
): Promise<{ subject: string; html: string }> {
  if (!shows.length) throw new Error("Cannot compose a festival run without shows");
  const first = shows[0];
  const vars = await buildVarsForShow({
    artistName,
    venueName: first.venueName,
    showDate: first.date,
    managerName: null,
    eventName: first.eventName,
    city: first.city,
    state: first.state,
    countryCode: first.countryCode,
    countryName: first.countryName,
  }, readSetting);
  const values = {
    ...vars,
    run_festivals: [...new Set(shows.map((show) => show.eventName || show.venueName))].join(" / "),
    run_cities: [...new Set(shows.map((show) =>
      `${show.city}${show.state ? `, ${show.state}` : ""}`,
    ))].join(" / "),
    run_dates: [...new Set(shows.map((show) =>
      formatShowDate(show.date, { month: "short", day: "numeric" }),
    ))].join(", "),
  };
  return {
    subject: applyTemplate(template.subject, values),
    html: applyHtmlTemplate(template.htmlBody, values),
  };
}
