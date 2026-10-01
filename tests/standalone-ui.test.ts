import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DemoADTClient } from "../src/adt-client.js";
import { MemoryAuditLog } from "../src/audit-log.js";
import { SecurityService } from "../src/security-service.js";
import { startStandaloneDashboard } from "../src/standalone-ui.js";
import type { CameraSnapshot } from "../src/types.js";

test("standalone dashboard is loopback-only, token-protected, and supports the full confirmation flow", async (t) => {
  const service = new SecurityService(new SnapshotDemoADTClient(), new MemoryAuditLog());
  const standalone = await startStandaloneDashboard({
    service,
    appHtmlPath: fileURLToPath(new URL("../src/mcp-app.html", import.meta.url)),
  });
  t.after(() => standalone.close());

  assert.match(standalone.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  const session = standalone.createSession();
  const sessionUrl = new URL(session.url);
  assert.equal(sessionUrl.pathname, "/mcp-app.html");
  assert.equal(sessionUrl.search, "");
  assert.equal(session.sessionMode, "interactive");
  const bootstrapToken = new URLSearchParams(sessionUrl.hash.slice(1)).get("token");
  assert.ok(bootstrapToken);
  const exchanged = await fetch(`${standalone.origin}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: standalone.origin },
    body: JSON.stringify({ bootstrapToken }),
  });
  assert.equal(exchanged.status, 200);
  const exchangeValue = await exchanged.json() as { token?: string };
  assert.ok(exchangeValue.token);
  const token = exchangeValue.token;
  const replayedBootstrap = await fetch(`${standalone.origin}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: standalone.origin },
    body: JSON.stringify({ bootstrapToken }),
  });
  assert.equal(replayedBootstrap.status, 401);
  const authenticatedHeaders = { Authorization: `Bearer ${token}` };
  const mutationHeaders = {
    ...authenticatedHeaders,
    "Content-Type": "application/json",
    Origin: standalone.origin,
  };

  const html = await fetch(session.url);
  assert.equal(html.status, 200);
  assert.match(html.headers.get("content-type") ?? "", /^text\/html/);
  assert.equal(html.headers.get("cache-control"), "no-store");

  const hostileHostStatus = await rawStatus(standalone.origin, "/mcp-app.html", "attacker.invalid");
  assert.equal(hostileHostStatus, 403);

  const denied = await fetch(`${standalone.origin}/api/dashboard`);
  assert.equal(denied.status, 401);

  const dashboard = await fetch(`${standalone.origin}/api/dashboard`, {
    headers: authenticatedHeaders,
  });
  assert.equal(dashboard.status, 200);
  const value = await dashboard.json() as { system?: { mode?: string } };
  assert.equal(value.system?.mode, "demo");

  const alerts = await fetch(`${standalone.origin}/api/alerts?limit=20`, { headers: authenticatedHeaders });
  assert.equal(alerts.status, 200);
  assert.ok(Array.isArray((await alerts.json() as { alerts?: unknown[] }).alerts));
  const invalidLimit = await fetch(`${standalone.origin}/api/alerts?limit=0`, { headers: authenticatedHeaders });
  assert.equal(invalidLimit.status, 400);

  const historyBefore = await fetch(`${standalone.origin}/api/history?limit=50`, { headers: authenticatedHeaders });
  assert.equal(historyBefore.status, 200);

  const hostileOrigin = await fetch(`${standalone.origin}/api/actions/prepare`, {
    method: "POST",
    headers: { ...mutationHeaders, Origin: "https://attacker.invalid" },
    body: JSON.stringify({ action: { type: "lock", lockId: "lock-1", locked: false } }),
  });
  assert.equal(hostileOrigin.status, 403);

  const invalidAuto = await fetch(`${standalone.origin}/api/actions/prepare`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ action: { type: "thermostat", thermostatId: "thermostat-1", mode: "auto", heatTarget: 78, coolTarget: 70 } }),
  });
  assert.equal(invalidAuto.status, 400);

  const prepared = await fetch(`${standalone.origin}/api/actions/prepare`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ action: { type: "lock", lockId: "lock-1", locked: false } }),
  });
  assert.equal(prepared.status, 200);
  const confirmation = await prepared.json() as { token?: string };
  assert.ok(confirmation.token);

  const committed = await fetch(`${standalone.origin}/api/actions/commit`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({
      action: { type: "lock", lockId: "lock-1", locked: false },
      confirmationToken: confirmation.token,
    }),
  });
  assert.equal(committed.status, 200);
  const operation = await committed.json() as { status?: string };
  assert.equal(operation.status, "completed");

  const replayed = await fetch(`${standalone.origin}/api/actions/commit`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({
      action: { type: "lock", lockId: "lock-1", locked: false },
      confirmationToken: confirmation.token,
    }),
  });
  assert.equal(replayed.status, 409);

  const refreshed = await fetch(`${standalone.origin}/api/dashboard`, { headers: authenticatedHeaders });
  const refreshedValue = await refreshed.json() as { devices?: Array<{ id: string; status: string }>; recentActivity?: unknown[] };
  assert.equal(refreshedValue.devices?.find((device) => device.id === "lock-1")?.status, "unlocked");
  assert.equal(refreshedValue.recentActivity?.length, 1);

  const snapshot = await fetch(`${standalone.origin}/api/cameras/camera-1/snapshot`, { headers: authenticatedHeaders });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await snapshot.arrayBuffer()), new Uint8Array([1, 2, 3]));

  const missing = await fetch(`${standalone.origin}/`);
  assert.equal(missing.status, 404);
});

function rawStatus(origin: string, pathname: string, hostHeader: string): Promise<number | undefined> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: url.hostname,
      port: url.port,
      path: pathname,
      method: "GET",
      headers: { Host: hostHeader },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    outgoing.once("error", reject);
    outgoing.end();
  });
}

class SnapshotDemoADTClient extends DemoADTClient {
  override async getCameraSnapshot(cameraId: string): Promise<CameraSnapshot> {
    return {
      cameraId,
      mimeType: "image/png",
      data: Buffer.from([1, 2, 3]).toString("base64"),
      bytes: 3,
      capturedAt: "2026-08-15T12:00:00.000Z",
    };
  }
}
