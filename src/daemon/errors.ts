export function toErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.message];
  if (error.cause instanceof Error) {
    parts.push(toErrorMessage(error.cause));
  }
  return parts.join(" — caused by: ");
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
