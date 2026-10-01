import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

test("built stdio server negotiates current MCP and keeps stdout protocol-clean", async (t) => {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "adt-mcp-test-"));
  const environment = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  environment.ADT_DEMO_MODE = "true";
  environment.ADT_AUDIT_LOG_PATH = path.join(temporaryDirectory, "audit.jsonl");

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve("dist/main.js")],
    cwd: process.cwd(),
    env: environment,
    stderr: "pipe",
  });
  const client = new Client(
    { name: "adt-stdio-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto", probe: { timeoutMs: 3_000 } } },
  );
  t.after(async () => {
    await client.close();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  await client.connect(transport);
  const tools = await client.listTools();
  assert.ok(tools.tools.some((tool) => tool.name === "adt-dashboard"));
  const dashboard = await client.callTool({ name: "adt-dashboard", arguments: {} });
  assert.equal((dashboard.structuredContent as { system?: { mode?: string } }).system?.mode, "demo");

  const standaloneResult = await client.callTool({ name: "open-standalone-dashboard", arguments: {} });
  assert.equal(standaloneResult.isError, undefined, JSON.stringify(standaloneResult));
  assert.equal((standaloneResult.structuredContent as { sessionMode?: string }).sessionMode, "interactive");
  const standaloneUrl = (standaloneResult.structuredContent as { url?: string }).url;
  assert.ok(standaloneUrl);
  const parsedStandaloneUrl = new URL(standaloneUrl);
  assert.equal(parsedStandaloneUrl.hostname, "127.0.0.1");
  const bootstrapToken = new URLSearchParams(parsedStandaloneUrl.hash.slice(1)).get("token");
  assert.ok(bootstrapToken);

  const standaloneHtml = await fetch(standaloneUrl);
  assert.equal(standaloneHtml.status, 200);
  assert.match(await standaloneHtml.text(), /adt-security-dashboard/);

  const exchange = await fetch(`${parsedStandaloneUrl.origin}/api/session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: parsedStandaloneUrl.origin },
    body: JSON.stringify({ bootstrapToken }),
  });
  assert.equal(exchange.status, 200);
  const token = (await exchange.json() as { token?: string }).token;
  assert.ok(token);

  const standaloneDashboard = await fetch(`${parsedStandaloneUrl.origin}/api/dashboard`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(standaloneDashboard.status, 200);
  const standaloneState = await standaloneDashboard.json() as { system?: { mode?: string } };
  assert.equal(standaloneState.system?.mode, "demo");

  const mutationHeaders = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    Origin: parsedStandaloneUrl.origin,
  };
  const prepared = await fetch(`${parsedStandaloneUrl.origin}/api/actions/prepare`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({ action: { type: "lock", lockId: "lock-1", locked: false } }),
  });
  assert.equal(prepared.status, 200);
  const confirmation = await prepared.json() as { token?: string };
  assert.ok(confirmation.token);

  const committed = await fetch(`${parsedStandaloneUrl.origin}/api/actions/commit`, {
    method: "POST",
    headers: mutationHeaders,
    body: JSON.stringify({
      action: { type: "lock", lockId: "lock-1", locked: false },
      confirmationToken: confirmation.token,
    }),
  });
  assert.equal(committed.status, 200);

  const resource = await client.readResource({ uri: "ui://adt-security/dashboard.html" });
  const resourceContent = resource.contents[0];
  assert.match(resourceContent && "text" in resourceContent ? resourceContent.text : "", /adt-security-dashboard/);
});
