import assert from "node:assert/strict";
import test from "node:test";
import { agentRulesValuesFromFormData } from "./form-state";

test("agent rules form preserves general and direct outreach text separately", () => {
  const formData = new FormData();
  formData.set("instructions", "Prefer official sources.");
  formData.set(
    "directOutreachInstructions",
    "When an artist is managed by Leif Fosse, add a direct outreach note that I have his number.",
  );
  assert.deepEqual(agentRulesValuesFromFormData(formData), {
    instructions: "Prefer official sources.",
    directOutreachInstructions:
      "When an artist is managed by Leif Fosse, add a direct outreach note that I have his number.",
  });
});
