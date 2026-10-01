import type { App } from "@modelcontextprotocol/ext-apps";

export type HostedFullscreenOutcome =
  | { kind: "mode"; mode: "inline" | "fullscreen" | "pip" }
  | { kind: "opened"; url: string }
  | { kind: "manual"; url: string };

export async function toggleHostedFullscreen(
  app: App,
  createStandaloneUrl: () => Promise<string>,
): Promise<HostedFullscreenOutcome> {
  const context = app.getHostContext();
  if (context?.displayMode === "fullscreen") {
    const result = await app.requestDisplayMode({ mode: "inline" }, { timeout: 5000 });
    return { kind: "mode", mode: result.mode };
  }

  if (context?.availableDisplayModes?.includes("fullscreen")) {
    try {
      const result = await app.requestDisplayMode({ mode: "fullscreen" }, { timeout: 5000 });
      if (result.mode === "fullscreen") return { kind: "mode", mode: result.mode };
    } catch {
      // Continue to the host-mediated browser fallback.
    }
  }

  const url = await createStandaloneUrl();
  if (app.getHostCapabilities()?.openLinks) {
    try {
      const result = await app.openLink({ url }, { timeout: 5000 });
      if (!result.isError) return { kind: "opened", url };
    } catch {
      // Return a manual fallback below.
    }
  }
  return { kind: "manual", url };
}
