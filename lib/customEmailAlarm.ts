import { Schedules, SchedulesApiError } from "@vercel/schedules";

const TOPIC = "custom-email-dispatch";
const NAMESPACE = "custom-emails";

export async function createCustomEmailAlarm(id: string, scheduledFor: Date) {
  const name = `email-${id}`;
  const at = scheduledFor.toISOString().slice(0, 16);
  try {
    await Schedules.create({
      name,
      namespace: NAMESPACE,
      expression: { type: "single", at },
      timezone: "UTC",
      target: { topic: TOPIC },
      payload: { id },
    });
  } catch (error) {
    if (!(error instanceof SchedulesApiError) || error.code !== "schedule_already_exists") {
      throw error;
    }
    const existing = await Schedules.get({ name, namespace: NAMESPACE });
    if (
      existing.state !== "active" ||
      existing.expression.type !== "single" ||
      existing.expression.at !== at ||
      existing.timezone !== "UTC" ||
      existing.target.type !== "queue" ||
      existing.target.topic !== TOPIC
    ) {
      throw new Error("Existing custom email alarm does not match the queued email");
    }
  }
}
