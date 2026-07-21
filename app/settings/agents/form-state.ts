export interface AgentRulesFormState {
  message: string | null;
  values: {
    instructions: string;
    directOutreachInstructions: string;
  };
  fieldErrors: {
    instructions?: string;
    directOutreachInstructions?: string;
  };
}

export function agentRulesValuesFromFormData(formData: FormData) {
  const instructions = formData.get("instructions");
  const directOutreachInstructions = formData.get(
    "directOutreachInstructions",
  );
  return {
    instructions: typeof instructions === "string" ? instructions : "",
    directOutreachInstructions:
      typeof directOutreachInstructions === "string"
        ? directOutreachInstructions
        : "",
  };
}
