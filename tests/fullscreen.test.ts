import type { App } from "@modelcontextprotocol/ext-apps";
import assert from "node:assert/strict";
import test from "node:test";
import { toggleHostedFullscreen } from "../src/fullscreen.js";

const standaloneUrl = "http://127.0.0.1:7357/mcp-app.html#token=test";

test("accepts native host fullscreen when the returned mode is fullscreen", async () => {
  let opened = false;
  const app = fakeApp({
    context: { displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] },
    requestedMode: "fullscreen",
    onOpen: () => { opened = true; },
  });

  const outcome = await toggleHostedFullscreen(app, async () => standaloneUrl);
  assert.deepEqual(outcome, { kind: "mode", mode: "fullscreen" });
  assert.equal(opened, false);
});

test("opens a browser when the host returns inline after requesting fullscreen", async () => {
  let opened = false;
  const app = fakeApp({
    context: { displayMode: "inline", availableDisplayModes: ["inline", "fullscreen"] },
    requestedMode: "inline",
    onOpen: () => { opened = true; },
  });

  const outcome = await toggleHostedFullscreen(app, async () => standaloneUrl);
  assert.deepEqual(outcome, { kind: "opened", url: standaloneUrl });
  assert.equal(opened, true);
});

test("opens a browser when fullscreen is not advertised", async () => {
  const app = fakeApp({
    context: { displayMode: "inline", availableDisplayModes: ["inline"] },
    requestedMode: "inline",
  });
  const outcome = await toggleHostedFullscreen(app, async () => standaloneUrl);
  assert.deepEqual(outcome, { kind: "opened", url: standaloneUrl });
});

test("reveals the manual URL when open-link is unavailable or denied", async () => {
  const unavailable = fakeApp({
    context: { displayMode: "inline", availableDisplayModes: ["inline"] },
    requestedMode: "inline",
    openLinks: false,
  });
  assert.deepEqual(
    await toggleHostedFullscreen(unavailable, async () => standaloneUrl),
    { kind: "manual", url: standaloneUrl },
  );

  const denied = fakeApp({
    context: { displayMode: "inline", availableDisplayModes: ["inline"] },
    requestedMode: "inline",
    openLinkDenied: true,
  });
  assert.deepEqual(
    await toggleHostedFullscreen(denied, async () => standaloneUrl),
    { kind: "manual", url: standaloneUrl },
  );
});

test("requests inline when already in host fullscreen", async () => {
  let requested: string | undefined;
  const app = fakeApp({
    context: { displayMode: "fullscreen", availableDisplayModes: ["inline", "fullscreen"] },
    requestedMode: "inline",
    onRequest: (mode) => { requested = mode; },
  });
  const outcome = await toggleHostedFullscreen(app, async () => standaloneUrl);
  assert.deepEqual(outcome, { kind: "mode", mode: "inline" });
  assert.equal(requested, "inline");
});

function fakeApp(options: {
  context: { displayMode: "inline" | "fullscreen"; availableDisplayModes: Array<"inline" | "fullscreen"> };
  requestedMode: "inline" | "fullscreen";
  openLinks?: boolean;
  openLinkDenied?: boolean;
  onOpen?: () => void;
  onRequest?: (mode: string) => void;
}): App {
  return {
    getHostContext: () => options.context,
    requestDisplayMode: async ({ mode }: { mode: string }) => {
      options.onRequest?.(mode);
      return { mode: options.requestedMode };
    },
    getHostCapabilities: () => options.openLinks === false ? {} : { openLinks: {} },
    openLink: async () => {
      options.onOpen?.();
      return options.openLinkDenied ? { isError: true } : {};
    },
  } as unknown as App;
}
