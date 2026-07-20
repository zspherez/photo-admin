export function toolStartLabel(event) {
  return (
    event?.data?.arguments?.description ??
    event?.data?.arguments?.command ??
    event?.data?.toolName ??
    "tool"
  );
}

export function formatToolFailure(event, startedTools) {
  const toolCallId = event?.data?.toolCallId;
  const started =
    typeof toolCallId === "string" ? startedTools.get(toolCallId) : null;
  const label =
    started?.label ?? event?.data?.toolName ?? "unidentified tool";
  const error = event?.data?.error;
  const denied =
    error?.code === "denied" ||
    event?.data?.toolTelemetry?.properties?.shell_error_category ===
      "permission_denied";
  const prefix = denied ? "Tool denied" : "Tool failed";
  const detail =
    typeof error?.message === "string" && error.message.trim()
      ? ` — ${error.message.trim()}`
      : "";
  return `${prefix}: ${label}${detail}`;
}
