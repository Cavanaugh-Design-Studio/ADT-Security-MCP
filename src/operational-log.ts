import { randomUUID } from "node:crypto";

export function logOperationalEvent(
  level: "info" | "warning" | "error",
  event: string,
  details: Record<string, unknown> = {},
): void {
  console.error(JSON.stringify({ level, event, ...details }));
}

export function logUnexpectedError(
  event: string,
  error: unknown,
  details: Record<string, unknown> = {},
): string {
  const correlationId = randomUUID();
  logOperationalEvent("error", event, {
    correlationId,
    errorType: error instanceof Error ? error.name : "UnknownError",
    ...details,
  });
  return correlationId;
}
