interface SessionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
const STORAGE_KEY = "adt-standalone-session";

export class StandaloneSessionManager {
  private token: string | undefined;
  private exchange: Promise<string> | undefined;
  private generation = 0;

  constructor(
    private bootstrap: string | undefined,
    private readonly storage: SessionStorage | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  useBootstrap(bootstrap: string): void {
    this.generation++;
    this.bootstrap = bootstrap;
    this.token = undefined;
    this.exchange = undefined;
    try { this.storage?.removeItem(STORAGE_KEY); } catch { /* Memory fallback. */ }
  }

  invalidate(token: string): void {
    // A late 401 for an old request must not clear a newer session.
    if (this.token !== token) return;
    this.token = undefined;
    try { this.storage?.removeItem(STORAGE_KEY); } catch { /* Memory fallback. */ }
  }

  async getToken(): Promise<string> {
    if (this.exchange) return this.exchange;
    if (!this.bootstrap) {
      if (this.token) return this.token;
      try { this.token = this.storage?.getItem(STORAGE_KEY) ?? undefined; } catch { /* Memory fallback. */ }
      if (this.token) return this.token;
      throw new Error("This dashboard session is unavailable. Request a new link from the MCP server.");
    }
    // A newly supplied one-use link always takes precedence over tab storage.
    const bootstrapToken = this.bootstrap;
    const generation = this.generation;
    this.bootstrap = undefined;
    this.token = undefined;
    try { this.storage?.removeItem(STORAGE_KEY); } catch { /* Memory fallback. */ }
    const exchange = (async () => {
      const response = await this.fetchImpl.call(globalThis, "/api/session", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bootstrapToken }), cache: "no-store",
        credentials: "omit", referrerPolicy: "no-referrer",
      });
      if (!response.ok) throw new Error("This dashboard link is invalid, expired, or could not be exchanged. Request a new link from the MCP server.");
      const value = await response.json() as { token?: string };
      if (!value.token) throw new Error("The standalone server did not return a browser session.");
      if (generation !== this.generation) throw new Error("A newer dashboard link was supplied. Refresh the dashboard.");
      this.token = value.token;
      try { this.storage?.setItem(STORAGE_KEY, value.token); } catch { /* Memory fallback. */ }
      return value.token;
    })();
    this.exchange = exchange;
    try { return await exchange; }
    finally { if (this.exchange === exchange) this.exchange = undefined; }
  }
}
