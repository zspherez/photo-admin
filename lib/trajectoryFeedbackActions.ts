import {
  attributeTrajectoryOutreach,
  recordTrajectoryFeedback,
  recordTrajectoryOutcome,
  type TrajectoryFeedbackInput,
  type TrajectoryOutcomeInput,
  type TrajectoryOutreachAttributionInput,
} from "@/lib/trajectoryFeedback";

export interface TrajectoryFeedbackActionDependencies {
  authorize: () => Promise<void>;
  recordFeedback: typeof recordTrajectoryFeedback;
  recordOutcome: typeof recordTrajectoryOutcome;
  attributeOutreach: typeof attributeTrajectoryOutreach;
  refresh: () => void;
}

function required(formData: FormData, key: string): string {
  const value = String(formData.get(key) ?? "").trim();
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

function nullable(formData: FormData, key: string): string | null {
  const value = String(formData.get(key) ?? "").trim();
  return value || null;
}

function nullableInteger(formData: FormData, key: string): number | null {
  const value = nullable(formData, key);
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isInteger(number)) throw new Error(`${key} must be an integer`);
  return number;
}

function nullableNumber(formData: FormData, key: string): number | null {
  const value = nullable(formData, key);
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${key} must be a number`);
  return number;
}

function attribution(formData: FormData) {
  return {
    recommendationId: required(formData, "recommendationId"),
    runId: required(formData, "runId"),
    showId: required(formData, "showId"),
    artistId: required(formData, "artistId"),
  };
}

function requiredBoolean(formData: FormData, key: string): boolean {
  const value = required(formData, key);
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${key} must be true or false`);
}

export async function executeTrajectoryFeedbackAction(
  formData: FormData,
  dependencies: TrajectoryFeedbackActionDependencies,
): Promise<void> {
  await dependencies.authorize();
  const input: TrajectoryFeedbackInput = {
    ...attribution(formData),
    action: required(formData, "action") as TrajectoryFeedbackInput["action"],
    propensity: nullableNumber(formData, "propensity"),
    notes: nullable(formData, "notes"),
    idempotencyKey: required(formData, "idempotencyKey"),
    supersedesId: nullable(formData, "supersedesId"),
  };
  await dependencies.recordFeedback(input);
  dependencies.refresh();
}

export async function executeTrajectoryOutcomeAction(
  formData: FormData,
  dependencies: TrajectoryFeedbackActionDependencies,
): Promise<void> {
  await dependencies.authorize();
  const input: TrajectoryOutcomeInput = {
    ...attribution(formData),
    attended: requiredBoolean(formData, "attended"),
    access: nullable(formData, "access") as TrajectoryOutcomeInput["access"],
    keeperCount: nullableInteger(formData, "keeperCount"),
    relationshipValue: nullableInteger(formData, "relationshipValue"),
    publicationValue: nullableInteger(formData, "publicationValue"),
    shootability: nullable(
      formData,
      "shootability",
    ) as TrajectoryOutcomeInput["shootability"],
    venueAccessibility: nullable(
      formData,
      "venueAccessibility",
    ) as TrajectoryOutcomeInput["venueAccessibility"],
    notes: nullable(formData, "notes"),
    idempotencyKey: required(formData, "idempotencyKey"),
    supersedesId: nullable(formData, "supersedesId"),
  };
  await dependencies.recordOutcome(input);
  dependencies.refresh();
}

export async function executeTrajectoryOutreachAttributionAction(
  formData: FormData,
  dependencies: TrajectoryFeedbackActionDependencies,
): Promise<void> {
  await dependencies.authorize();
  const input: TrajectoryOutreachAttributionInput = {
    ...attribution(formData),
    outreachId: required(formData, "outreachId"),
  };
  await dependencies.attributeOutreach(input);
  dependencies.refresh();
}
