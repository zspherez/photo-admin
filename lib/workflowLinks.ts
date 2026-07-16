export function withWorkflowReturnTo(path: string, returnTo: string): string {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[\\\u0000-\u001f\u007f-\u009f]/.test(path)
  ) {
    throw new Error("Workflow destination must be an internal path");
  }
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}returnTo=${encodeURIComponent(returnTo)}`;
}
