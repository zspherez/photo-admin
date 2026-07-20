import assert from "node:assert/strict";
import test from "node:test";
import {
  formatToolFailure,
  toolStartLabel,
} from "./contact-research-tool-log.mjs";

test("maps failed completions back to their tool start", () => {
  const start = {
    data: {
      toolCallId: "call-1",
      toolName: "bash",
      arguments: {
        command: "cat /tmp/output",
        description: "Check line lengths in output file",
      },
    },
  };
  const started = new Map([
    ["call-1", { label: toolStartLabel(start), toolName: "bash" }],
  ]);
  assert.equal(
    formatToolFailure(
      {
        data: {
          toolCallId: "call-1",
          success: false,
          error: {
            message: "Permission denied and could not request permission from user",
            code: "denied",
          },
          toolTelemetry: {
            properties: {
              shell_error_category: "permission_denied",
            },
          },
        },
      },
      started
    ),
    "Tool denied: Check line lengths in output file — Permission denied and could not request permission from user"
  );
});

test("uses the command when no description is supplied", () => {
  assert.equal(
    toolStartLabel({
      data: {
        toolName: "bash",
        arguments: { command: "cat /tmp/output" },
      },
    }),
    "cat /tmp/output"
  );
});
