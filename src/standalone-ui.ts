import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import * as z from "zod/v4";
import { ADTError } from "./adt-client.js";
import { ConfirmationError } from "./confirmation-store.js";
import { logUnexpectedError } from "./operational-log.js";
import { SecurityService, ServiceError } from "./security-service.js";
import { SecurityActionSchema } from "./types.js";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;
const DEFAULT_BOOTSTRAP_TTL_MS = 2 * 60 * 1000;
const MAX_SESSIONS = 100;
const MAX_JSON_BODY_BYTES = 16 * 1024;
const ActionRequestSchema = z.object({ action: SecurityActionSchema }).strict();
const CommitRequestSchema = z.object({
  action: SecurityActionSchema,
  confirmationToken: z.string().min(20).max(200),
}).strict();
const BootstrapRequestSchema = z.object({ bootstrapToken: z.string().min(20).max(200) }).strict();

export interface StandaloneSession {
  [key: string]: unknown;
  url: string;
  expiresAt: string;
  sessionMode: "interactive";
  sessionDurationMinutes: number;
}

export interface StandaloneDashboardHandle {
  createSession(): StandaloneSession;
  close(): Promise<void>;
  readonly origin: string;
}

export interface StartStandaloneDashboardOptions {
  service: SecurityService;
  appHtmlPath: string;
  port?: number;
  sessionTtlMs?: number;
  bootstrapTtlMs?: number;
}

export async function startStandaloneDashboard(
  options: StartStandaloneDashboardOptions,
): Promise<StandaloneDashboardHandle> {
  const sessions = new Map<string, number>();
  const bootstrapTokens = new Map<string, number>();
  const sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const bootstrapTtlMs = options.bootstrapTtlMs ?? DEFAULT_BOOTSTRAP_TTL_MS;
  let origin = "";

  const server = createHttpServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin || `http://${LOOPBACK_HOST}`);
    setSecurityHeaders(response);

    if (origin && request.headers.host !== new URL(origin).host) {
      sendJson(response, 403, { error: { code: "INVALID_HOST", message: "The request Host header is not allowed." } });
      return;
    }

    if (request.method === "GET" && url.pathname === "/mcp-app.html") {
      try {
        const html = await readFile(options.appHtmlPath, "utf8");
        response.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
        }).end(html);
      } catch {
        response.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" })
          .end("The ADT dashboard is not built. Run npm run build and restart the MCP server.");
      }
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      if (!isAllowedOrigin(request, origin)) {
        sendJson(response, 403, { error: { code: "INVALID_ORIGIN", message: "The request Origin is not allowed." } });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/session") {
        try {
          const body = BootstrapRequestSchema.parse(await readJsonBody(request));
          const bootstrapExpiresAt = bootstrapTokens.get(body.bootstrapToken);
          bootstrapTokens.delete(body.bootstrapToken);
          if (bootstrapExpiresAt === undefined || bootstrapExpiresAt <= Date.now()) {
            throw new HttpError(401, "BOOTSTRAP_INVALID", "This dashboard link is invalid, expired, or has already been opened.");
          }
          pruneExpiredSessions(sessions);
          enforceCapacity(sessions);
          const token = randomBytes(32).toString("base64url");
          const expiresAtMs = Date.now() + sessionTtlMs;
          sessions.set(token, expiresAtMs);
          sendJson(response, 200, {
            token,
            expiresAt: new Date(expiresAtMs).toISOString(),
            sessionMode: "interactive",
          });
        } catch (error) {
          sendApiError(response, error);
        }
        return;
      }
      const token = bearerToken(request.headers.authorization);
      const expiresAt = token ? sessions.get(token) : undefined;
      if (!token || expiresAt === undefined || expiresAt <= Date.now()) {
        if (token) sessions.delete(token);
        sendJson(response, 401, { error: { code: "SESSION_INVALID", message: "This standalone dashboard session is invalid or expired. Open a new dashboard link from the MCP server." } });
        return;
      }

      try {
        await handleApiRequest(request, response, url, options.service);
      } catch (error) {
        sendApiError(response, error);
      }
      return;
    }

    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  });

  await listen(server, options.port ?? 0);
  const address = server.address() as AddressInfo;
  origin = `http://${LOOPBACK_HOST}:${address.port}`;

  return {
    origin,
    createSession() {
      pruneExpiredSessions(bootstrapTokens);
      enforceCapacity(bootstrapTokens);
      const bootstrapToken = randomBytes(32).toString("base64url");
      const expiresAtMs = Date.now() + bootstrapTtlMs;
      bootstrapTokens.set(bootstrapToken, expiresAtMs);
      return {
        url: `${origin}/mcp-app.html#token=${encodeURIComponent(bootstrapToken)}`,
        expiresAt: new Date(expiresAtMs).toISOString(),
        sessionMode: "interactive",
        sessionDurationMinutes: Math.max(1, Math.floor(sessionTtlMs / 60_000)),
      };
    },
    close: () => close(server),
  };
}

async function handleApiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  service: SecurityService,
): Promise<void> {
  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    sendJson(response, 200, await service.getDashboard());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/alerts") {
    const alerts = await service.getAlerts(parseLimit(url, 20));
    sendJson(response, 200, { alerts, refreshedAt: new Date().toISOString() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/history") {
    sendJson(response, 200, { events: await service.getHistory(parseLimit(url, 50)) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/actions/prepare") {
    const body = ActionRequestSchema.parse(await readJsonBody(request));
    sendJson(response, 200, await service.prepare(body.action));
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/actions/commit") {
    const body = CommitRequestSchema.parse(await readJsonBody(request));
    sendJson(response, 200, await service.commit(body.confirmationToken, body.action));
    return;
  }

  const snapshotMatch = /^\/api\/cameras\/([^/]+)\/snapshot$/.exec(url.pathname);
  if (request.method === "GET" && snapshotMatch?.[1]) {
    let cameraId: string;
    try {
      cameraId = decodeURIComponent(snapshotMatch[1]);
    } catch {
      throw new HttpError(400, "VALIDATION_ERROR", "Camera ID is invalid.");
    }
    if (!cameraId.trim() || cameraId.length > 200) throw new HttpError(400, "VALIDATION_ERROR", "Camera ID is invalid.");
    const snapshot = await service.provider.getCameraSnapshot(cameraId);
    const bytes = Buffer.from(snapshot.data, "base64");
    response.writeHead(200, {
      "Content-Type": snapshot.mimeType,
      "Content-Length": bytes.byteLength,
      "X-ADT-Camera-Id": encodeURIComponent(snapshot.cameraId),
      "X-ADT-Captured-At": snapshot.capturedAt,
    }).end(bytes);
    return;
  }

  throw new HttpError(404, "NOT_FOUND", "API endpoint not found.");
}

function parseLimit(url: URL, defaultValue: number): number {
  const raw = url.searchParams.get("limit");
  if (raw === null) return defaultValue;
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new HttpError(400, "VALIDATION_ERROR", "Limit must be an integer from 1 through 100.");
  }
  return limit;
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(415, "UNSUPPORTED_MEDIA_TYPE", "Requests must use application/json.");
  }

  const declaredLength = Number(request.headers["content-length"] ?? 0);
  if (!Number.isFinite(declaredLength) || declaredLength < 0 || declaredLength > MAX_JSON_BODY_BYTES) {
    throw new HttpError(413, "REQUEST_TOO_LARGE", "Request body exceeds the 16 KB limit.");
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_JSON_BODY_BYTES) throw new HttpError(413, "REQUEST_TOO_LARGE", "Request body exceeds the 16 KB limit.");
    chunks.push(bytes);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body must contain valid JSON.");
  }
}

function isAllowedOrigin(request: IncomingMessage, origin: string): boolean {
  const requestOrigin = request.headers.origin;
  if (request.method === "POST") return requestOrigin === origin;
  return requestOrigin === undefined || requestOrigin === origin;
}

function setSecurityHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" }).end(JSON.stringify(value));
}

function sendApiError(response: ServerResponse, error: unknown): void {
  if (error instanceof HttpError) {
    sendJson(response, error.status, { error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof z.ZodError) {
    sendJson(response, 400, { error: { code: "VALIDATION_ERROR", message: "Request fields are invalid." } });
    return;
  }
  if (error instanceof ConfirmationError) {
    const status = error.code === "CONFIRMATION_EXPIRED" ? 410 : 409;
    sendJson(response, status, { error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof ServiceError) {
    sendJson(response, error.code === "MUTATIONS_DISABLED" ? 403 : 400, { error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof ADTError) {
    const status = error.code === "DEVICE_NOT_FOUND" ? 404
      : error.code === "ACTION_NOT_ALLOWED" ? 403
        : error.code === "SNAPSHOT_TOO_LARGE" ? 413
          : error.code === "UPSTREAM_TIMEOUT" ? 504
            : error.code === "CONFIGURATION_ERROR" ? 503
              : 502;
    sendJson(response, status, { error: { code: error.code, message: error.message } });
    return;
  }
  const correlationId = logUnexpectedError("standalone_api_unexpected_error", error);
  sendJson(response, 500, { error: { code: "INTERNAL_ERROR", message: `The ADT operation failed. Check the server's redacted stderr log for correlation ${correlationId}.` } });
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "HttpError";
  }
}

function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const token = authorization.slice("Bearer ".length).trim();
  return token || undefined;
}

function pruneExpiredSessions(sessions: Map<string, number>): void {
  const now = Date.now();
  for (const [token, expiresAt] of sessions) {
    if (expiresAt <= now) sessions.delete(token);
  }
}

function enforceCapacity(entries: Map<string, number>): void {
  while (entries.size >= MAX_SESSIONS) {
    const oldest = entries.keys().next().value as string | undefined;
    if (!oldest) return;
    entries.delete(oldest);
  }
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, LOOPBACK_HOST);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeIdleConnections();
    server.close((error) => error ? reject(error) : resolve());
  });
}
