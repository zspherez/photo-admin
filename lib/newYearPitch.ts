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

export const NEW_YEAR_PITCH_TEMPLATE_NAME = "new_year_run_outreach";
export const NEW_YEAR_PITCH_VARIABLES = [
  ...COMMON_TEMPLATE_VARS,
  "run_cities",
  "run_dates",
] as const;

export const DEFAULT_NEW_YEAR_PITCH: TemplateContent = {
  subject: "{{artist}} New Year's run photo/video coverage",
  htmlBody:
    "<p>Hi there, I wanted to reach out about {{artist}}'s New Year's shows in {{run_cities}} ({{run_dates}}). I am a photographer and videographer specializing in electronic music and would love to work together to capture the run!</p>" +
    "<p>Here's a brief summary of my deliverables, and I'm happy to work with you to meet your needs!</p>" +
    "<p>My minimum deliverables include 25 photos and 3-5 clips night of show; complete gallery with 50+ additional photos and 7-10 additional clips the following day.</p>" +
    '<p>You can check out some examples of my previous work at <a href="{{portfolio_url}}">{{portfolio_url}}</a></p>' +
    "<p>Best,<br>{{sender_name}}<br>{{sender_email}} // {{sender_phone}}</p>",
};

export function validateNewYearPitchTemplate(content: TemplateContent): string[] {
  return [
    ...malformedTemplateVariableTokens(content),
    ...extractVars(`${content.subject} ${content.htmlBody}`).filter(
      (variable) => !NEW_YEAR_PITCH_VARIABLES.includes(
        variable as (typeof NEW_YEAR_PITCH_VARIABLES)[number]
      )
    ),
  ];
}

export async function readNewYearPitchTemplate(): Promise<TemplateContent> {
  const saved = await db.emailTemplate.findUnique({
    where: { name: NEW_YEAR_PITCH_TEMPLATE_NAME },
  });
  return saved ? normalizeTemplateContent(saved) : DEFAULT_NEW_YEAR_PITCH;
}

export async function renderNewYearPitch(
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
  readSetting?: Parameters<typeof buildVarsForShow>[1]
): Promise<{ subject: string; html: string }> {
  if (!shows.length) throw new Error("Cannot compose a pitch without shows");
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
  const runCities = [...new Set(shows.map((show) =>
    `${show.city}${show.state ? `, ${show.state}` : ""}`
  ))];
  const runDates = [...new Set(shows.map((show) =>
    formatShowDate(show.date, { month: "short", day: "numeric" })
  ))];
  const values = {
    ...vars,
    run_cities: runCities.join(" / "),
    run_dates: runDates.join(", "),
  };
  return {
    subject: applyTemplate(template.subject, values),
    html: applyHtmlTemplate(template.htmlBody, values),
  };
}
