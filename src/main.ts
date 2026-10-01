import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { logOperationalEvent } from "./operational-log.js";
import { createDefaultSecurityService, createServer, resolveAppHtmlPath } from "./server.js";
import { startStandaloneDashboard, type StandaloneDashboardHandle } from "./standalone-ui.js";
import { APP_VERSION } from "./version.js";

const service = createDefaultSecurityService();
let standaloneDashboard: StandaloneDashboardHandle | undefined;
try {
  standaloneDashboard = await startStandaloneDashboard({
    service,
    appHtmlPath: resolveAppHtmlPath(),
    port: standalonePort(),
  });
  logOperationalEvent("info", "standalone_ui_started", { origin: standaloneDashboard.origin });
} catch (error) {
  logOperationalEvent("warning", "standalone_ui_unavailable", {
    errorType: error instanceof Error ? error.name : "UnknownError",
  });
}

const handle = serveStdio(() => createServer({
  service,
  ...(standaloneDashboard ? { createStandaloneSession: () => standaloneDashboard.createSession() } : {}),
}), {
  legacy: "serve",
  onerror: (error) => {
    logOperationalEvent("error", "mcp_transport_error", { errorType: error.name });
  },
});

logOperationalEvent("info", "server_started", { transport: "stdio", version: APP_VERSION });

let closing = false;
async function shutdown(signal: string): Promise<void> {
  if (closing) return;
  closing = true;
  logOperationalEvent("info", "server_stopping", { signal });
  await Promise.all([handle.close(), standaloneDashboard?.close()]);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).finally(() => process.exit(0));
  });
}

function standalonePort(): number {
  const raw = process.env.ADT_STANDALONE_PORT?.trim();
  if (!raw) return 0;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("ADT_STANDALONE_PORT must be an integer from 0 through 65535.");
  }
  return port;
}
