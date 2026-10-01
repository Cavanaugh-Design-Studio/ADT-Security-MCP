import { App, PostMessageTransport } from "@modelcontextprotocol/ext-apps";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { toggleHostedFullscreen } from "./fullscreen.js";
import { deriveDeviceAlerts } from "./device-alerts.js";
import { StandaloneSessionManager } from "./standalone-session.js";
import type { AuditEntry, Confirmation, Dashboard, Device, DeviceAlert, OperationResult, SecurityAction } from "./types.js";
import { APP_VERSION } from "./version.js";
import "./mcp-app.css";

type ToolResult = Awaited<ReturnType<App["callServerTool"]>>;

interface PendingAction {
  action: SecurityAction;
  token: string;
  summary: string;
  expiresAt: string;
  tool: string;
  args: Record<string, unknown>;
}

const standalone = window.parent === window || new URLSearchParams(window.location.search).has("standalone");
const entryMode = standalone ? "standalone" as const : "hosted" as const;
const isStandalone = entryMode === "standalone";
const standaloneSessions = new StandaloneSessionManager(readStandaloneBootstrapToken(), sessionStorageIfAvailable());

function AppRoot() {
  const [app, setApp] = useState<App>();
  const [dashboard, setDashboard] = useState<Dashboard>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [noticeTone, setNoticeTone] = useState<"success" | "warning">("success");
  const [pending, setPending] = useState<PendingAction>();
  const [snapshot, setSnapshot] = useState<string>();
  const [fullscreen, setFullscreen] = useState(false);
  const [popoutUrl, setPopoutUrl] = useState<string>();
  const [alerts, setAlerts] = useState<DeviceAlert[]>([]);
  const [history, setHistory] = useState<AuditEntry[]>([]);

  const applyResult = useCallback((result: ToolResult) => {
    if (result.isError) {
      throw new Error(textFromResult(result) || "ADT tool returned an error.");
    }
    const value = structuredObject(result);
    if (value && "system" in value && "devices" in value) {
      const nextDashboard = value as Dashboard;
      setDashboard(nextDashboard);
      setAlerts(deriveDeviceAlerts(nextDashboard.devices, nextDashboard.refreshedAt, 20));
      setHistory(nextDashboard.recentActivity);
    }
    if (value && "alerts" in value && Array.isArray(value.alerts)) setAlerts(value.alerts as DeviceAlert[]);
    if (value && "events" in value && Array.isArray(value.events)) setHistory(value.events as AuditEntry[]);
    return value;
  }, []);

  const call = useCallback(async (name: string, args: Record<string, unknown>) => {
    if (!app) throw new Error("The MCP App is not connected to its host.");
    const result = await app.callServerTool({ name, arguments: args });
    return { result, value: applyResult(result) };
  }, [app, applyResult]);

  const refresh = useCallback(async () => {
    if (!isStandalone && !app) return;
    setLoading(true);
    setError(undefined);
    try {
      if (isStandalone) {
        const nextDashboard = await standaloneJson<Dashboard>("/api/dashboard");
        setDashboard(nextDashboard);
        setAlerts(deriveDeviceAlerts(nextDashboard.devices, nextDashboard.refreshedAt, 20));
        setHistory(nextDashboard.recentActivity);
      } else {
        await call("adt-dashboard", { action: "refresh" });
      }
      const alertsRequest: Promise<Record<string, unknown>> = isStandalone
        ? standaloneJson<Record<string, unknown>>("/api/alerts?limit=20")
        : call("get-alerts", { limit: 20 }).then(({ value }) => value ?? {});
      const historyRequest: Promise<Record<string, unknown>> = isStandalone
        ? standaloneJson<Record<string, unknown>>("/api/history?limit=50")
        : call("get-event-history", { limit: 50 }).then(({ value }) => value ?? {});
      const [alertsResult, historyResult] = await Promise.allSettled([alertsRequest, historyRequest]);
      if (alertsResult.status === "fulfilled") {
        const value = alertsResult.value;
        if (value && "alerts" in value && Array.isArray(value.alerts)) setAlerts(value.alerts as DeviceAlert[]);
      }
      if (historyResult.status === "fulfilled") {
        const value = historyResult.value;
        if (value && "events" in value && Array.isArray(value.events)) setHistory(value.events as AuditEntry[]);
      }
      const secondaryFailures = [alertsResult, historyResult].filter((result) => result.status === "rejected").length;
      if (secondaryFailures) setError(`Dashboard refreshed, but ${secondaryFailures} supporting view${secondaryFailures === 1 ? "" : "s"} could not be updated.`);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoading(false);
    }
  }, [app, call]);

  useEffect(() => {
    if (isStandalone) return;
    const appCapabilities = {
      availableDisplayModes: ["inline", "fullscreen"] as Array<"inline" | "fullscreen">,
    };
    const next = new App(
      { name: "adt-security-dashboard", version: APP_VERSION },
      appCapabilities,
      { strict: true },
    );
    next.ontoolresult = (result) => {
      try {
        applyResult(result);
      } catch (cause) {
        setError(messageOf(cause));
      } finally {
        setLoading(false);
      }
    };
    next.onerror = () => setError("The MCP host reported a dashboard communication error.");
    next.onhostcontextchanged = (context) => {
      if (context.theme) document.documentElement.dataset.theme = context.theme;
      if (context.displayMode) setFullscreen(context.displayMode === "fullscreen");
    };

    let active = true;
    void next.connect(new PostMessageTransport(window.parent, window.parent)).then(() => {
      if (!active) return;
      const context = next.getHostContext();
      if (context?.theme) document.documentElement.dataset.theme = context.theme;
      if (context?.displayMode) setFullscreen(context.displayMode === "fullscreen");
      setApp(next);
    }).catch((cause) => {
      if (active) setError(`Could not connect to the MCP host: ${messageOf(cause)}`);
      setLoading(false);
    });

    return () => {
      active = false;
      void next.close();
    };
  }, [applyResult]);

  useEffect(() => {
    if ((isStandalone || app) && !dashboard) void refresh();
  }, [app, dashboard, refresh]);

  useEffect(() => {
    if (!isStandalone) return;
    const acceptLink = () => {
      const token = readStandaloneBootstrapToken();
      if (!token) return;
      standaloneSessions.useBootstrap(token);
      void refresh();
    };
    window.addEventListener("hashchange", acceptLink);
    return () => window.removeEventListener("hashchange", acceptLink);
  }, [refresh]);

  useEffect(() => {
    if (!pending) return;
    const cancel = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPending(undefined);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [pending]);

  useEffect(() => {
    const sync = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, []);

  const toggleFullscreen = useCallback(async () => {
    setError(undefined);
    setNotice(undefined);
    setPopoutUrl(undefined);

    if (isStandalone) {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await document.documentElement.requestFullscreen();
      } catch (cause) {
        setError(`Browser fullscreen was denied: ${messageOf(cause)}`);
      }
      return;
    }

    if (!app) {
      setError("The MCP App is still connecting to its host.");
      return;
    }

    try {
      const outcome = await toggleHostedFullscreen(app, async () => {
        const sessionResult = await app.callServerTool({ name: "open-standalone-dashboard", arguments: {} });
        if (sessionResult.isError) throw new Error(textFromResult(sessionResult) || "The standalone dashboard is unavailable.");
        const session = structuredObject(sessionResult);
        const url = typeof session?.url === "string" ? session.url : undefined;
        if (!url) throw new Error("The server did not return a standalone dashboard URL.");
        return url;
      });

      if (outcome.kind === "mode") {
        setFullscreen(outcome.mode === "fullscreen");
        return;
      }
      setPopoutUrl(outcome.url);
      setNotice(outcome.kind === "opened"
        ? "Opened the full interactive dashboard in the browser."
        : "Your host did not open the browser. Copy the local link below into VS Code Simple Browser or another browser.");
    } catch (cause) {
      setError(messageOf(cause));
    }
  }, [app]);

  const copyPopoutUrl = useCallback(async () => {
    if (!popoutUrl) return;
    try {
      await navigator.clipboard.writeText(popoutUrl);
      setNotice("Standalone dashboard link copied.");
    } catch {
      setNotice("Select the local link and copy it manually.");
    }
  }, [popoutUrl]);

  const prepare = useCallback(async (
    action: SecurityAction,
    tool: string,
    args: Record<string, unknown>,
  ) => {
    setError(undefined);
    setNotice(undefined);
    setBusy(true);
    try {
      const confirmation = isStandalone
        ? await standaloneJson<Confirmation>("/api/actions/prepare", "POST", { action })
        : (await call("prepare-security-action", { action })).value as Confirmation | undefined;
      if (!confirmation?.token) throw new Error("Server did not return a confirmation token.");
      setPending({
        action,
        tool,
        args,
        token: confirmation.token,
        summary: confirmation.summary,
        expiresAt: confirmation.expiresAt,
      });
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }, [call]);

  const commit = useCallback(async () => {
    if (!pending) return;
    setBusy(true);
    setError(undefined);
    try {
      let summary: string;
      let requiresAttention = false;
      if (isStandalone) {
        const result = await standaloneJson<OperationResult>("/api/actions/commit", "POST", {
          action: pending.action,
          confirmationToken: pending.token,
        });
        summary = result.warning ? `${result.summary} Warning: ${result.warning}` : result.summary;
        requiresAttention = result.status !== "completed" || Boolean(result.warning);
      } else {
        const { result, value } = await call(pending.tool, { ...pending.args, confirmationToken: pending.token });
        summary = textFromResult(result) || "ADT action completed.";
        requiresAttention = value?.status !== "completed" || Boolean(value?.warning);
      }
      setNoticeTone(requiresAttention ? "warning" : "success");
      setNotice(summary);
      setPending(undefined);
      await refresh();
    } catch (cause) {
      setError(messageOf(cause));
      setPending(undefined);
    } finally {
      setBusy(false);
    }
  }, [call, pending, refresh]);

  const takeSnapshot = useCallback(async (cameraId: string) => {
    setBusy(true);
    setError(undefined);
    try {
      if (isStandalone) {
        setSnapshot(await standaloneSnapshot(cameraId));
      } else {
        const { result } = await call("get-camera-snapshot", { cameraId });
        const image = result.content.find((item) => item.type === "image");
        if (!image || image.type !== "image") throw new Error("Camera did not return an image.");
        setSnapshot(`data:${image.mimeType};base64,${image.data}`);
      }
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }, [call]);

  if (!dashboard && loading) {
    return <StatusScreen title="Connecting securely" detail="Waiting for current ADT device state…" />;
  }
  if (!dashboard) {
    return <StatusScreen title="Dashboard unavailable" detail={error ?? "No dashboard data was returned."} retry={() => void refresh()} />;
  }

  const panels = dashboard.devices.filter((device) => device.type === "panel");
  const systemLabel = dashboard.system.armStatus === "armed" ? `Armed ${dashboard.system.armMode ?? ""}`
    : dashboard.system.armStatus === "disarmed" ? "Disarmed"
      : dashboard.system.armStatus === "mixed" ? "Mixed panel states" : "Security state unknown";
  const warnings = dashboard.devices.filter((device) => device.status === "unknown" || device.status === "offline" || device.status === "triggered" || device.battery === "low" || device.battery === "critical");

  return (
    <main className={`shell${fullscreen ? " is-fullscreen" : ""}`} aria-busy={loading || busy}>
      <header className="topbar">
        <div>
          <div className="eyebrow"><span className={`mode-dot ${dashboard.system.mode}`} /> {dashboard.system.mode} mode</div>
          <h1>ADT Home Security</h1>
          <p className="subtle">Updated {formatTime(dashboard.refreshedAt)}</p>
        </div>
        <div className="topbar-actions">
          <button
            type="button"
            className="button secondary icon-only"
            onClick={toggleFullscreen}
            aria-label="Toggle fullscreen"
            title={fullscreen ? "Exit fullscreen" : "Open fullscreen (browser fallback available)"}
          >{fullscreen ? "⤡" : "⤢"}</button>
          <button type="button" className="button secondary" onClick={() => void refresh()} disabled={loading || busy}>↻ Refresh</button>
        </div>
      </header>

      {error && <div className="banner error" role="alert"><span>{error}</span><button aria-label="Dismiss error" onClick={() => setError(undefined)}>×</button></div>}
      {notice && <div className={`banner ${noticeTone}`} role="status"><span>{notice}</span><button aria-label="Dismiss message" onClick={() => setNotice(undefined)}>×</button></div>}
      {popoutUrl && (
        <div className="banner popout-fallback" role="status">
          <label>Standalone dashboard URL<input value={popoutUrl} readOnly onFocus={(event) => event.currentTarget.select()} /></label>
          <button type="button" className="button secondary" onClick={() => void copyPopoutUrl()}>Copy link</button>
        </div>
      )}
      {isStandalone && <div className="banner success" role="status">Secure standalone session. Dashboard controls use the same server validation and two-step confirmation flow as the MCP App.</div>}
      {dashboard.system.mode === "real" && !dashboard.system.mutationsEnabled && (
        <div className="banner warning" role="status">{dashboard.system.mutationWarning ?? "Read-only mode is active. Enable device control in the host configuration only after validating device state."}</div>
      )}

      <section className="hero-grid" aria-label="Security overview">
        <article className={`system-card ${dashboard.system.armStatus}`}>
          <div className="system-icon" aria-hidden="true">{dashboard.system.armed ? "◆" : "◇"}</div>
          <div>
            <p className="label">Security system</p>
            <h2>{systemLabel}</h2>
            <p>{dashboard.system.connectedDevices} of {dashboard.system.totalDevices} devices connected</p>
          </div>
          <div className="panel-controls">
          {panels.map((panel) => (
            <div key={panel.id}>
              <p><strong>{panel.name}</strong> · {panel.status}{panel.armMode ? ` ${panel.armMode}` : ""}</p>
              <div className="actions">
              <button disabled={busy || !dashboard.system.mutationsEnabled || !panel.capabilities.includes("arm")} onClick={() => void prepare({ type: "arm", panelId: panel.id, mode: "stay" }, "arm-system", { panelId: panel.id, mode: "stay" })}>Arm stay</button>
              <button disabled={busy || !dashboard.system.mutationsEnabled || !panel.capabilities.includes("arm")} onClick={() => void prepare({ type: "arm", panelId: panel.id, mode: "away" }, "arm-system", { panelId: panel.id, mode: "away" })}>Arm away</button>
              <button className="danger" disabled={busy || !dashboard.system.mutationsEnabled || !panel.capabilities.includes("disarm")} onClick={() => void prepare({ type: "disarm", panelId: panel.id }, "disarm-system", { panelId: panel.id })}>Disarm</button>
              </div>
            </div>
          ))}
          {!panels.length && <p>No security panel is reporting state.</p>}
          </div>
        </article>

        <article className="health-card">
          <p className="label">System health</p>
          <div className={`health-value ${dashboard.system.health}`}><span />{dashboard.system.health}</div>
          <p>{warnings.length ? `${warnings.length} device${warnings.length === 1 ? "" : "s"} need attention` : !panels.length ? "No security panel is reporting state" : "All reporting devices look normal"}</p>
        </article>
      </section>

      <section className="section" aria-labelledby="alerts-title">
        <div className="section-heading">
          <div><p className="label">Current conditions</p><h2 id="alerts-title">Alerts</h2></div>
          <span className="count">{alerts.length}</span>
        </div>
        {alerts.length ? (
          <ul className="alert-list">
            {alerts.map((alert) => (
              <li key={alert.id} className={alert.severity}>
                <span className="alert-severity">{alert.severity}</span>
                <div><strong>{alert.deviceName}</strong><p>{alert.message}</p></div>
              </li>
            ))}
          </ul>
        ) : <p className="empty">No current device alerts.</p>}
      </section>

      <section className="section">
        <div className="section-heading"><div><p className="label">Live state</p><h2>Devices</h2></div><span className="count">{dashboard.devices.length}</span></div>
        <div className="device-grid">
          {dashboard.devices.filter((device) => device.type !== "panel").map((device) => (
            <DeviceCard
              key={device.id}
              device={device}
              disabled={busy || !dashboard.system.mutationsEnabled}
              snapshotDisabled={busy}
              onPrepare={prepare}
              onSnapshot={takeSnapshot}
            />
          ))}
        </div>
      </section>

      <section className="section activity">
        <div className="section-heading"><div><p className="label">Redacted local record</p><h2>Recent actions</h2></div></div>
        {history.length ? (
          <ol className="timeline">
            {history.map((entry) => (
              <li key={entry.id}><span className={`timeline-dot ${entry.outcome}`} /><div><strong>{entry.summary}</strong><p>{formatTime(entry.timestamp)} · {entry.outcome}</p></div></li>
            ))}
          </ol>
        ) : <p className="empty">No actions have been recorded by this server.</p>}
      </section>

      {snapshot && (
        <div className="overlay" role="dialog" aria-modal="true" aria-label="Camera snapshot">
          <div className="dialog snapshot-dialog"><img src={snapshot} alt="Current ADT camera snapshot" /><button className="button secondary" onClick={() => setSnapshot(undefined)}>Close</button></div>
        </div>
      )}

      {pending && (
        <div className="overlay" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-detail">
          <div className="dialog">
            <div className="confirm-icon" aria-hidden="true">!</div>
            <p className="label">Explicit confirmation required</p>
            <h2 id="confirm-title">Confirm security action</h2>
            <p id="confirm-detail" className="confirm-summary">{pending.summary}</p>
            <p className="subtle">This one-use authorization expires {formatTime(pending.expiresAt)}.</p>
            <div className="dialog-actions">
              <button className="button secondary" onClick={() => setPending(undefined)} disabled={busy}>Cancel</button>
              <button className="button danger-solid" onClick={() => void commit()} disabled={busy}>{busy ? "Working…" : "Confirm action"}</button>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}

function DeviceCard({
  device,
  disabled,
  snapshotDisabled,
  onPrepare,
  onSnapshot,
}: {
  device: Device;
  disabled: boolean;
  snapshotDisabled: boolean;
  onPrepare: (action: SecurityAction, tool: string, args: Record<string, unknown>) => Promise<void>;
  onSnapshot: (cameraId: string) => Promise<void>;
}) {
  const [brightness, setBrightness] = useState(Math.max(1, device.brightness ?? 100));
  const [heatTarget, setHeatTarget] = useState(device.heatTarget ?? 68);
  const [coolTarget, setCoolTarget] = useState(device.coolTarget ?? 74);
  const icon = useMemo(() => ({ sensor: "⌁", lock: "▣", light: "✦", thermostat: "◉", camera: "▰", panel: "◆" })[device.type], [device.type]);

  return (
    <article className="device-card">
      <div className="device-head"><span className={`device-icon ${device.type}`}>{icon}</span><span className={`status ${device.status}`}>{device.status}</span></div>
      <h3>{device.name}</h3>
      <p className="device-meta">{device.type.replace("-", " ")}{device.battery && device.battery !== "normal" ? ` · ${device.battery} battery` : ""}</p>

      {device.type === "lock" && (
        <button className={device.status === "locked" ? "secondary full" : "danger full"} disabled={disabled} onClick={() => void onPrepare(
          { type: "lock", lockId: device.id, locked: device.status !== "locked" },
          "control-lock",
          { lockId: device.id, action: device.status === "locked" ? "unlock" : "lock" },
        )}>{device.status === "locked" ? "Unlock" : "Lock"}</button>
      )}

      {device.type === "light" && (
        <div className="control-stack">
          {device.isDimmer && <label>Brightness <span>{brightness}%</span><input type="range" min="1" max="100" value={brightness} onChange={(event) => setBrightness(Number(event.target.value))} disabled={disabled} /></label>}
          <button className="secondary full" disabled={disabled} onClick={() => void onPrepare(
            { type: "light", lightId: device.id, isOn: device.status !== "on", ...(device.isDimmer && device.status !== "on" ? { brightness } : {}) },
            "control-light",
            { lightId: device.id, isOn: device.status !== "on", ...(device.isDimmer && device.status !== "on" ? { brightness } : {}) },
          )}>Turn {device.status === "on" ? "off" : "on"}</button>
        </div>
      )}

      {device.type === "thermostat" && (
        <div className="control-stack">
          <div className="temperature"><strong>{device.currentTemp ?? "—"}°</strong><span>{device.thermostatMode ?? "unknown"}</span></div>
          <label>Heat target <span>{heatTarget}°F</span><input type="range" min="45" max="95" value={heatTarget} onChange={(event) => setHeatTarget(Number(event.target.value))} disabled={disabled} /></label>
          <label>Cool target <span>{coolTarget}°F</span><input type="range" min="45" max="95" value={coolTarget} onChange={(event) => setCoolTarget(Number(event.target.value))} disabled={disabled} /></label>
          {heatTarget >= coolTarget && <p className="field-warning">Heat target must be lower than cool target for auto mode.</p>}
          <div className="split-actions thermostat-actions">
            <button disabled={disabled} onClick={() => void onPrepare({ type: "thermostat", thermostatId: device.id, mode: "heat", targetTemp: heatTarget }, "set-thermostat", { thermostatId: device.id, mode: "heat", targetTemp: heatTarget })}>Heat</button>
            <button disabled={disabled} onClick={() => void onPrepare({ type: "thermostat", thermostatId: device.id, mode: "cool", targetTemp: coolTarget }, "set-thermostat", { thermostatId: device.id, mode: "cool", targetTemp: coolTarget })}>Cool</button>
            <button disabled={disabled || heatTarget >= coolTarget} onClick={() => void onPrepare({ type: "thermostat", thermostatId: device.id, mode: "auto", heatTarget, coolTarget }, "set-thermostat", { thermostatId: device.id, mode: "auto", heatTarget, coolTarget })}>Auto</button>
            <button className="secondary" disabled={disabled} onClick={() => void onPrepare({ type: "thermostat", thermostatId: device.id, mode: "off" }, "set-thermostat", { thermostatId: device.id, mode: "off" })}>Off</button>
          </div>
        </div>
      )}

      {device.type === "camera" && <button className="secondary full" disabled={snapshotDisabled || !device.canTakeSnapshot} onClick={() => void onSnapshot(device.id)}>Take snapshot</button>}
      {device.type === "sensor" && <p className="sensor-reading">{device.triggered ? "Attention required" : "Normal"}{device.sensorType ? ` · ${device.sensorType}` : ""}</p>}
    </article>
  );
}

function StatusScreen({ title, detail, retry }: { title: string; detail: string; retry?: () => void }) {
  return <main className="status-screen"><div className="brand-mark">◆</div><h1>{title}</h1><p>{detail}</p>{retry && <button className="button" onClick={retry}>Try again</button>}</main>;
}

function structuredObject(result: ToolResult): Record<string, unknown> | undefined {
  if (result.structuredContent && typeof result.structuredContent === "object") return result.structuredContent;
  const text = textFromResult(result);
  if (!text) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function textFromResult(result: ToolResult): string {
  return result.content.filter((item) => item.type === "text").map((item) => item.type === "text" ? item.text : "").join("\n");
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : "An unexpected ADT dashboard error occurred.";
}

function formatTime(value: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  } catch {
    return value;
  }
}

function readStandaloneBootstrapToken(): string | undefined {
  if (!isStandalone) return undefined;
  const bootstrapToken = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? undefined;
  try {
    if (bootstrapToken) window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  } catch {
    // The token is still held in memory and never sent in an HTTP URL.
  }
  return bootstrapToken;
}

function sessionStorageIfAvailable(): Storage | undefined {
  if (!isStandalone) return undefined;
  try { return window.sessionStorage; } catch { return undefined; }
}

async function standaloneJson<T>(
  path: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
): Promise<T> {
  const token = await standaloneSessions.getToken();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const request: RequestInit = {
    method,
    headers,
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    request.body = JSON.stringify(body);
  }
  const response = await fetch(path, request);
  if (!response.ok) {
    if (response.status === 401) standaloneSessions.invalidate(token);
    throw new Error(await standaloneError(response));
  }
  return await response.json() as T;
}

async function standaloneSnapshot(cameraId: string): Promise<string> {
  const token = await standaloneSessions.getToken();
  const response = await fetch(`/api/cameras/${encodeURIComponent(cameraId)}/snapshot`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
    credentials: "omit",
    referrerPolicy: "no-referrer",
  });
  if (!response.ok) {
    if (response.status === 401) standaloneSessions.invalidate(token);
    throw new Error(await standaloneError(response));
  }
  return await blobAsDataUrl(await response.blob());
}

async function standaloneError(response: Response): Promise<string> {
  try {
    const value: unknown = await response.json();
    if (value && typeof value === "object" && "error" in value && value.error && typeof value.error === "object" && "message" in value.error && typeof value.error.message === "string") {
      return value.error.message;
    }
  } catch {
    // Use the status fallback below.
  }
  return `Standalone dashboard request failed (${response.status}).`;
}

function blobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Camera snapshot could not be read."));
    reader.onload = () => typeof reader.result === "string"
      ? resolve(reader.result)
      : reject(new Error("Camera snapshot returned an invalid payload."));
    reader.readAsDataURL(blob);
  });
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><AppRoot /></React.StrictMode>);
