"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireServerActionAuth } from "@/lib/auth";
import {
  normalizeContactAuditAgentRules,
  saveContactAuditAgentRules,
} from "@/lib/contactAuditAgentRules";
import {
  auditAgentRulesValuesFromFormData,
  type AuditAgentRulesFormState,
} from "./form-state";

export async function saveAuditAgentRulesAction(
  _previousState: AuditAgentRulesFormState,
  formData: FormData,
): Promise<AuditAgentRulesFormState> {
  await requireServerActionAuth("/settings/agents/audit");
  const values = auditAgentRulesValuesFromFormData(formData);
  try {
    normalizeContactAuditAgentRules(values.instructions);
  } catch (error) {
    return {
      message: "Correct the highlighted field and save again.",
      values,
      fieldErrors: {
        instructions:
          error instanceof Error ? error.message : String(error),
      },
    };
  }

  try {
    await saveContactAuditAgentRules(values);
  } catch (error) {
    console.error("Unable to save contact audit agent rules", error);
    return {
      message: "Unable to save audit agent rules. Try again.",
      values,
      fieldErrors: {},
    };
  }

  revalidatePath("/settings/agents/audit");
  revalidatePath("/settings");
  redirect("/settings/agents/audit?saved=1");
}
