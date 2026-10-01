import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { DemoADTClient } from "../src/adt-client.js";
import { MemoryAuditLog } from "../src/audit-log.js";
import { SecurityService } from "../src/security-service.js";
import { createServer } from "../src/server.js";

test("MCP contract exposes structured output, UI resource, errors, and confirmation-gated mutation", async (t) => {
  const service = new SecurityService(new DemoADTClient(), new MemoryAuditLog());
  const server = createServer({
    service,
    appHtml: "<!doctype html><title>ADT</title>",
    createStandaloneSession: () => ({
      url: "http://127.0.0.1:7357/mcp-app.html#token=test-token",
      expiresAt: "2030-01-01T00:00:00.000Z",
      sessionMode: "interactive",
      sessionDurationMinutes: 60,
    }),
  });
  const client = new Client({ name: "adt-contract-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const { tools } = await client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["adt-dashboard", "arm-system", "control-light", "control-lock", "disarm-system", "get-alerts", "get-camera-snapshot", "get-event-history", "open-standalone-dashboard", "prepare-security-action", "set-thermostat"].sort(),
  );
  assert.ok(tools.every((tool) => tool.outputSchema), "every tool must publish an output schema");
  for (const name of ["arm-system", "disarm-system", "control-lock", "control-light", "set-thermostat"]) {
    const annotations = tools.find((tool) => tool.name === name)?.annotations;
    assert.equal(annotations?.readOnlyHint, false, `${name} must be marked as a mutation`);
    assert.equal(annotations?.idempotentHint, false, `${name} uses a one-use confirmation token and is not replay-idempotent`);
  }
  const dashboardMeta = tools.find((tool) => tool.name === "adt-dashboard")?._meta as { ui?: { resourceUri?: string } } | undefined;
  assert.equal(dashboardMeta?.ui?.resourceUri, "ui://adt-security/dashboard.html");
  const standaloneMeta = tools.find((tool) => tool.name === "open-standalone-dashboard")?._meta as { ui?: { visibility?: string[] } } | undefined;
  assert.deepEqual(standaloneMeta?.ui?.visibility, ["model", "app"]);

  const dashboard = await client.callTool({ name: "adt-dashboard", arguments: { action: "refresh" } });
  assert.equal(dashboard.isError, undefined);
  assert.equal((dashboard.structuredContent as { system?: { mode?: string } }).system?.mode, "demo");

  const standalone = await client.callTool({ name: "open-standalone-dashboard", arguments: {} });
  assert.equal(standalone.isError, undefined);
  assert.equal((standalone.structuredContent as { sessionMode?: string }).sessionMode, "interactive");
  assert.match((standalone.structuredContent as { url?: string }).url ?? "", /^http:\/\/127\.0\.0\.1:/);
  assert.match(standalone.content[0]?.type === "text" ? standalone.content[0].text : "", /http:\/\/127\.0\.0\.1:/);

  const invalid = await client.callTool({ name: "control-lock", arguments: { lockId: "lock-1", action: "unlock", confirmationToken: "invalid-but-long-enough-token" } });
  assert.equal(invalid.isError, true);
  assert.match(invalid.content[0]?.type === "text" ? invalid.content[0].text : "", /CONFIRMATION_INVALID/);

  const invalidThermostat = await client.callTool({
    name: "set-thermostat",
    arguments: { thermostatId: "thermostat-1", mode: "auto", heatTarget: 78, coolTarget: 70, confirmationToken: "invalid-but-long-enough-token" },
  });
  assert.equal(invalidThermostat.isError, true, JSON.stringify(invalidThermostat));

  const action = { type: "lock", lockId: "lock-1", locked: false } as const;
  const prepared = await client.callTool({ name: "prepare-security-action", arguments: { action } });
  assert.equal(prepared.isError, undefined, JSON.stringify(prepared));
  const token = (prepared.structuredContent as { token?: string }).token;
  assert.ok(token);
  const committed = await client.callTool({ name: "control-lock", arguments: { lockId: "lock-1", action: "unlock", confirmationToken: token } });
  assert.equal((committed.structuredContent as { status?: string }).status, "completed");

  const resource = await client.readResource({ uri: "ui://adt-security/dashboard.html" });
  assert.equal(resource.contents[0]?.mimeType, "text/html;profile=mcp-app");
  const resourceContent = resource.contents[0];
  assert.match(resourceContent && "text" in resourceContent ? resourceContent.text : "", /ADT/);
});
