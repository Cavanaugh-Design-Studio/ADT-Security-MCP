import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const expectedTools = [
  "adt-dashboard",
  "open-standalone-dashboard",
  "prepare-security-action",
  "arm-system",
  "disarm-system",
  "control-lock",
  "control-light",
  "set-thermostat",
  "get-alerts",
  "get-event-history",
  "get-camera-snapshot",
];

test("every advertised tool has a concrete dashboard workflow", async () => {
  const [serverSource, appSource, standaloneSource] = await Promise.all([
    readFile(new URL("../src/server.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/mcp-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../src/standalone-ui.ts", import.meta.url), "utf8"),
  ]);
  const registered = [...serverSource.matchAll(/server\.registerTool\(\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(registered, expectedTools);

  for (const tool of expectedTools) {
    assert.match(appSource, new RegExp(escapeRegExp(tool)), `${tool} is not wired in the dashboard`);
  }
  for (const endpoint of ["/api/dashboard", "/api/alerts", "/api/history", "/api/actions/prepare", "/api/actions/commit", "/snapshot"]) {
    assert.match(standaloneSource, new RegExp(escapeRegExp(endpoint)), `${endpoint} is not wired in the standalone server`);
  }
  assert.match(appSource, /mode:\s*"auto",\s*heatTarget,\s*coolTarget/, "thermostat auto mode is not wired");
  assert.doesNotMatch(appSource, /disabled=\{isStandalone\s*\|\|/, "standalone controls must not be globally disabled");
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
