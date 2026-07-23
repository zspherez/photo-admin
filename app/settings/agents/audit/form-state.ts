export interface AuditAgentRulesFormState {
  message: string | null;
  values: {
    instructions: string;
    autoAppendAdditionalContact: boolean;
  };
  fieldErrors: {
    instructions?: string;
  };
}

export function auditAgentRulesValuesFromFormData(formData: FormData) {
  const instructions = formData.get("instructions");
  const autoAppendAdditionalContact = formData.get(
    "autoAppendAdditionalContact",
  );
  return {
    instructions: typeof instructions === "string" ? instructions : "",
    autoAppendAdditionalContact: autoAppendAdditionalContact === "true",
  };
}
