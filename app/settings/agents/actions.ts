"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireServerActionAuth } from "@/lib/auth";
import {
  normalizeDirectOutreachInstructions,
  normalizeGlobalAgentRules,
  saveGlobalAgentRuleSet,
} from "@/lib/agentRules";
import {
  agentRulesValuesFromFormData,
  type AgentRulesFormState,
} from "./form-state";

export async function saveAgentRulesAction(
  _previousState: AgentRulesFormState,
  formData: FormData,
): Promise<AgentRulesFormState> {
  await requireServerActionAuth("/settings/agents");
  const values = agentRulesValuesFromFormData(formData);
  const fieldErrors: AgentRulesFormState["fieldErrors"] = {};
  try {
    normalizeGlobalAgentRules(values.instructions);
  } catch (error) {
    fieldErrors.instructions =
      error instanceof Error ? error.message : String(error);
  }
  try {
    normalizeDirectOutreachInstructions(
      values.directOutreachInstructions,
    );
  } catch (error) {
    fieldErrors.directOutreachInstructions =
      error instanceof Error ? error.message : String(error);
  }
  if (Object.keys(fieldErrors).length > 0) {
    return {
      message: "Correct the highlighted fields and save again.",
      values,
      fieldErrors,
    };
  }
  try {
    await saveGlobalAgentRuleSet(values);
  } catch (error) {
    console.error("Unable to save global agent rules", error);
    return {
      message: "Unable to save agent rules. Try again.",
      values,
      fieldErrors: {},
    };
  }
  revalidatePath("/settings/agents");
  revalidatePath("/settings");
  redirect("/settings/agents?saved=1");
}
