import { McpServer } from "@modelcontextprotocol/server";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod/v4";
import { ADTError, createSecurityProvider } from "./adt-client.js";
import { JsonlAuditLog } from "./audit-log.js";
import { ConfirmationError } from "./confirmation-store.js";
import { logUnexpectedError } from "./operational-log.js";
import { SecurityService, ServiceError } from "./security-service.js";
import type { StandaloneSession } from "./standalone-ui.js";
import {
  AlertsResponseSchema,
  ConfirmationSchema,
  DashboardSchema,
  HistoryResponseSchema,
  OperationResultSchema,
  SecurityActionSchema,
  type OperationResult,
  type SecurityAction,
} from "./types.js";
import { APP_VERSION } from "./version.js";

const RESOURCE_URI = "ui://adt-security/dashboard.html";
const RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";
const ConfirmationTokenSchema = z.string().min(20).max(200).describe("One-use token returned by prepare-security-action");
const StableIdSchema = z.string().trim().min(1).max(200);
const FahrenheitSchema = z.number().min(45).max(95);

const appToolMeta = {
  ui: {
    resourceUri: RESOURCE_URI,
    visibility: ["model", "app"],
  },
};

export interface CreateServerOptions {
  service?: SecurityService;
  appHtml?: string;
  createStandaloneSession?: () => StandaloneSession;
}

export function createDefaultSecurityService(): SecurityService {
  const provider = createSecurityProvider();
  const auditPath = process.env.ADT_AUDIT_LOG_PATH?.trim() || path.join(homedir(), ".adt-mcp", "audit.jsonl");
  return new SecurityService(provider, new JsonlAuditLog(path.resolve(auditPath)));
}

export function createServer(options: CreateServerOptions = {}): McpServer {
  const service = options.service ?? createDefaultSecurityService();
  const server = new McpServer({ name: "ADT Security MCP Server", version: APP_VERSION });

  server.registerTool(
    "adt-dashboard",
    {
      title: "ADT Security Dashboard",
      description: "Read the current ADT security system and device state. Credentials come only from the server environment.",
      inputSchema: z.object({ action: z.enum(["view", "refresh"]).optional().default("view") }),
      outputSchema: DashboardSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: appToolMeta,
    },
    async () => toolCall(async () => {
      const dashboard = await service.getDashboard();
      return successResult(dashboard, summarizeDashboard(dashboard));
    }),
  );

  server.registerTool(
    "open-standalone-dashboard",
    {
      title: "Open ADT Dashboard in Browser",
      description: "Create an expiring, loopback-only URL for the full interactive ADT dashboard. Use this when the MCP client cannot render MCP Apps or constrains the app inside a frame.",
      inputSchema: z.object({}),
      outputSchema: z.object({
        url: z.url(),
        expiresAt: z.iso.datetime(),
        sessionMode: z.literal("interactive"),
        sessionDurationMinutes: z.number().int().positive(),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: {
        ui: {
          resourceUri: RESOURCE_URI,
          visibility: ["model", "app"],
        },
      },
    },
    async () => {
      if (!options.createStandaloneSession) {
        return {
          content: [{ type: "text" as const, text: "STANDALONE_UNAVAILABLE: The loopback dashboard server is not running." }],
          isError: true,
        };
      }
      return toolCall(async () => {
        const session = options.createStandaloneSession?.();
        if (!session) throw new Error("Standalone session creation failed.");
        return successResult(session, `Open the interactive ADT dashboard at ${session.url}. This one-use link expires at ${session.expiresAt}; the browser session lasts ${session.sessionDurationMinutes} minutes.`);
      });
    },
  );

  server.registerTool(
    "prepare-security-action",
    {
      title: "Preview ADT Security Action",
      description: "Validate and preview one security-system mutation. Returns a short-lived, one-use token required by the matching mutation tool. Show the summary to the user before continuing.",
      inputSchema: z.object({ action: SecurityActionSchema }),
      outputSchema: ConfirmationSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: appToolMeta,
    },
    async ({ action }) => toolCall(async () => {
      const confirmation = await service.prepare(action);
      return successResult(confirmation, `Confirmation required: ${confirmation.summary}. Token expires at ${confirmation.expiresAt}.`);
    }),
  );

  server.registerTool(
    "arm-system",
    {
      title: "Arm ADT Security System",
      description: "Arm one exact panel after prepare-security-action returned a matching confirmation token.",
      inputSchema: z.object({ panelId: StableIdSchema, mode: z.enum(["stay", "away"]), confirmationToken: ConfirmationTokenSchema }),
      outputSchema: OperationResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      _meta: appToolMeta,
    },
    async ({ panelId, mode, confirmationToken }) => mutationCall(service, confirmationToken, { type: "arm", panelId, mode }),
  );

  server.registerTool(
    "disarm-system",
    {
      title: "Disarm ADT Security System",
      description: "Disarm one exact panel after prepare-security-action returned a matching confirmation token. This reduces physical security and requires explicit user approval.",
      inputSchema: z.object({ panelId: StableIdSchema, confirmationToken: ConfirmationTokenSchema }),
      outputSchema: OperationResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      _meta: appToolMeta,
    },
    async ({ panelId, confirmationToken }) => mutationCall(service, confirmationToken, { type: "disarm", panelId }),
  );

  server.registerTool(
    "control-lock",
    {
      title: "Control ADT Door Lock",
      description: "Lock or unlock one exact lock after prepare-security-action returned a matching confirmation token. Unlocking requires explicit user approval.",
      inputSchema: z.object({ lockId: StableIdSchema, action: z.enum(["lock", "unlock"]), confirmationToken: ConfirmationTokenSchema }),
      outputSchema: OperationResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
      _meta: appToolMeta,
    },
    async ({ lockId, action, confirmationToken }) => mutationCall(service, confirmationToken, { type: "lock", lockId, locked: action === "lock" }),
  );

  server.registerTool(
    "control-light",
    {
      title: "Control ADT Light",
      description: "Turn a light on or off, optionally setting dimmer brightness, after prepare-security-action returned a matching confirmation token.",
      inputSchema: z.object({
        lightId: StableIdSchema,
        isOn: z.boolean(),
        brightness: z.number().int().min(1).max(100).optional(),
        confirmationToken: ConfirmationTokenSchema,
      }),
      outputSchema: OperationResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: appToolMeta,
    },
    async ({ lightId, isOn, brightness, confirmationToken }) => mutationCall(service, confirmationToken, {
      type: "light",
      lightId,
      isOn,
      ...(brightness === undefined ? {} : { brightness }),
    }),
  );

  const thermostatInput = z.union([
    z.object({ thermostatId: StableIdSchema, mode: z.literal("off"), confirmationToken: ConfirmationTokenSchema }),
    z.object({ thermostatId: StableIdSchema, mode: z.enum(["heat", "cool"]), targetTemp: FahrenheitSchema, confirmationToken: ConfirmationTokenSchema }),
    z.object({ thermostatId: StableIdSchema, mode: z.literal("auto"), heatTarget: FahrenheitSchema, coolTarget: FahrenheitSchema, confirmationToken: ConfirmationTokenSchema })
      .refine((input) => input.heatTarget < input.coolTarget, { message: "Auto heat target must be lower than the cool target.", path: ["coolTarget"] }),
  ]);
  server.registerTool(
    "set-thermostat",
    {
      title: "Set ADT Thermostat",
      description: "Change thermostat mode and bounded Fahrenheit setpoints after prepare-security-action returned a matching confirmation token.",
      inputSchema: thermostatInput,
      outputSchema: OperationResultSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: appToolMeta,
    },
    async (input) => {
      const { confirmationToken, ...actionInput } = input;
      return mutationCall(service, confirmationToken, { type: "thermostat", ...actionInput } as SecurityAction);
    },
  );

  server.registerTool(
    "get-alerts",
    {
      title: "Get Current ADT Alerts",
      description: "Derive current actionable alerts from live device state, including triggered sensors, offline devices, and battery warnings. This is not provider event history.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional().default(20) }),
      outputSchema: AlertsResponseSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      _meta: appToolMeta,
    },
    async ({ limit }) => toolCall(async () => {
      const alerts = await service.getAlerts(limit);
      const output = { alerts, refreshedAt: new Date().toISOString() };
      return successResult(output, alerts.length ? alerts.map((alert) => `${alert.severity.toUpperCase()}: ${alert.message}`).join("\n") : "No current ADT device alerts.");
    }),
  );

  server.registerTool(
    "get-event-history",
    {
      title: "Get Local ADT Action History",
      description: "Read the redacted local audit history of mutation attempts made through this MCP server. It is not Alarm.com provider history.",
      inputSchema: z.object({ limit: z.number().int().min(1).max(100).optional().default(50) }),
      outputSchema: HistoryResponseSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: appToolMeta,
    },
    async ({ limit }) => toolCall(async () => {
      const events = await service.getHistory(limit);
      return successResult({ events }, events.length ? events.map((event) => `${event.timestamp} ${event.outcome}: ${event.summary}`).join("\n") : "No local ADT actions have been recorded.");
    }),
  );

  server.registerTool(
    "get-camera-snapshot",
    {
      title: "Get ADT Camera Snapshot",
      description: "Fetch a current camera snapshot through the server. Signed provider URLs are never returned.",
      inputSchema: z.object({ cameraId: StableIdSchema }),
      outputSchema: z.object({ cameraId: z.string(), mimeType: z.string(), bytes: z.number().int().nonnegative(), capturedAt: z.string() }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      _meta: appToolMeta,
    },
    async ({ cameraId }) => toolCall(async () => {
      const snapshot = await service.provider.getCameraSnapshot(cameraId);
      const metadata = { cameraId: snapshot.cameraId, mimeType: snapshot.mimeType, bytes: snapshot.bytes, capturedAt: snapshot.capturedAt };
      return {
        content: [
          { type: "text" as const, text: `Captured ${snapshot.bytes} byte snapshot from camera ${snapshot.cameraId}.` },
          { type: "image" as const, data: snapshot.data, mimeType: snapshot.mimeType },
        ],
        structuredContent: metadata,
      };
    }),
  );

  server.registerResource(
    "adt-security-dashboard",
    RESOURCE_URI,
    {
      title: "ADT Security Dashboard",
      description: "Interactive ADT security dashboard",
      mimeType: RESOURCE_MIME_TYPE,
      _meta: {
        ui: {
          csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
          prefersBorder: true,
        },
      },
    },
    async (uri) => {
      const html = options.appHtml ?? await readFile(resolveAppHtmlPath(), "utf8");
      return {
        contents: [{
          uri: uri.href,
          mimeType: RESOURCE_MIME_TYPE,
          text: html,
          _meta: {
            ui: {
              csp: { connectDomains: [], resourceDomains: [], frameDomains: [], baseUriDomains: [] },
              prefersBorder: true,
            },
          },
        }],
      };
    },
  );

  return server;
}

export function resolveAppHtmlPath(): string {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  return path.basename(currentDirectory) === "src"
    ? path.resolve(currentDirectory, "..", "dist", "mcp-app.html")
    : path.resolve(currentDirectory, "mcp-app.html");
}

async function mutationCall(service: SecurityService, token: string, action: SecurityAction) {
  return toolCall(async () => {
    const result = await service.commit(token, action);
    return successResult(result, result.warning ? `${result.summary} WARNING: ${result.warning}` : result.summary);
  });
}

async function toolCall<T>(operation: () => Promise<T>): Promise<T | { content: [{ type: "text"; text: string }]; isError: true }> {
  try {
    return await operation();
  } catch (error) {
    return {
      content: [{ type: "text", text: safeErrorMessage(error) }],
      isError: true,
    };
  }
}

function successResult<T extends Record<string, unknown> | OperationResult>(structuredContent: T, text: string) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent,
  };
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof ADTError || error instanceof ConfirmationError || error instanceof ServiceError) {
    return `${error.code}: ${error.message}`;
  }
  const correlationId = logUnexpectedError("mcp_tool_unexpected_error", error);
  return `INTERNAL_ERROR: The ADT operation failed. Check the server's redacted stderr log for correlation ${correlationId}.`;
}

function summarizeDashboard(dashboard: z.infer<typeof DashboardSchema>): string {
  const status = dashboard.system.armStatus === "armed"
    ? `armed ${dashboard.system.armMode ?? ""}`.trim() : dashboard.system.armStatus;
  return `ADT system is ${status}; health is ${dashboard.system.health}; ${dashboard.system.connectedDevices}/${dashboard.system.totalDevices} devices are connected (${dashboard.system.mode} mode).`;
}
