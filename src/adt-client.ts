import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { Readable } from "node:stream";
import { checkServerIdentity } from "node:tls";
import * as alarm from "node-alarm-dot-com";
import type { AuthOpts, FlattenedSystemState } from "node-alarm-dot-com";
import { SensorType } from "node-alarm-dot-com";
import { isCriticalDevice, SecurityActionSchema, type CameraSnapshot, type Dashboard, type Device, type OperationResult, type SecurityAction, type SecurityProvider } from "./types.js";

const DEFAULT_TIMEOUT_MS = 45_000;
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const AUTH_CACHE_MS = 5 * 60 * 1000;
const SYSTEM_STATE = { DISARMED: 1, ARMED_STAY: 2, ARMED_AWAY: 3, ARMED_NIGHT: 4 } as const;
const SENSOR_STATE = { CLOSED: 1, OPEN: 2, IDLE: 3, ACTIVE: 4, DRY: 5, WET: 6 } as const;
const LIGHT_STATE = { ON: 2, OFF: 3 } as const;
const LOCK_STATE = { SECURED: 1, UNSECURED: 2 } as const;
const THERMOSTAT_STATE = { OFF: 1, HEATING: 2, COOLING: 3, AUTO: 4 } as const;
type ThermostatStateValue = Parameters<typeof alarm.setThermostatState>[1];
type PublicAddress = { address: string; family: number };
type FetchLike = (input: string | URL, init?: RequestInit, addresses?: PublicAddress[]) => Promise<Response>;
type LookupHost = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

export class ADTError extends Error {
  constructor(
    readonly code:
      | "CONFIGURATION_ERROR"
      | "AUTHENTICATION_FAILED"
      | "AMBIGUOUS_SYSTEM"
      | "DEVICE_NOT_FOUND"
      | "ACTION_NOT_ALLOWED"
      | "UPSTREAM_TIMEOUT"
      | "UPSTREAM_ERROR"
      | "SNAPSHOT_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "ADTError";
  }
}

export interface ADTEnvironment {
  ADT_USERNAME?: string;
  ADT_PASSWORD?: string;
  ADT_MFA_TOKEN?: string;
  ADT_SYSTEM_ID?: string;
  ADT_DEMO_MODE?: string;
  ADT_ALLOW_MUTATIONS?: string;
}

export function createSecurityProvider(env: ADTEnvironment = process.env): SecurityProvider {
  const username = env.ADT_USERNAME?.trim();
  const password = env.ADT_PASSWORD;
  const forceDemo = parseBoolean(env.ADT_DEMO_MODE, false);

  if (forceDemo || (!username && !password)) return new DemoADTClient();
  if (!username || !password) {
    throw new ADTError("CONFIGURATION_ERROR", "Set both ADT_USERNAME and ADT_PASSWORD, or enable ADT_DEMO_MODE.");
  }

  return new RealADTClient(
    {
      username,
      password,
      mfaToken: env.ADT_MFA_TOKEN,
      systemId: env.ADT_SYSTEM_ID,
      allowMutations: parseBoolean(env.ADT_ALLOW_MUTATIONS, false),
    },
    alarm,
  );
}

export interface AlarmApi {
  login(username: string, password: string, mfaToken?: string): Promise<Omit<AuthOpts, "expires"> & { expires?: number }>;
  getCurrentState(systemId: string, auth: AuthOpts): Promise<FlattenedSystemState>;
  armStay(partitionId: string, auth: AuthOpts, options: alarm.PartitionActionOptions): Promise<unknown>;
  armAway(partitionId: string, auth: AuthOpts, options: alarm.PartitionActionOptions): Promise<unknown>;
  disarm(partitionId: string, auth: AuthOpts): Promise<unknown>;
  setLockSecure(lockId: string, auth: AuthOpts): Promise<unknown>;
  setLockUnsecure(lockId: string, auth: AuthOpts): Promise<unknown>;
  setLightOn(lightId: string, auth: AuthOpts, brightness: number, isDimmer: boolean): Promise<unknown>;
  setLightOff(lightId: string, auth: AuthOpts, brightness: number, isDimmer: boolean): Promise<unknown>;
  setThermostatState(thermostatId: string, state: ThermostatStateValue, auth: AuthOpts): Promise<unknown>;
  setThermostatTargetHeatTemperature(thermostatId: string, temp: number, auth: AuthOpts): Promise<unknown>;
  setThermostatTargetCoolTemperature(thermostatId: string, temp: number, auth: AuthOpts): Promise<unknown>;
  getCameraSnapshotUrl(cameraId: string, auth: AuthOpts): Promise<string>;
}

export interface RealClientConfig {
  username: string;
  password: string;
  mfaToken: string | undefined;
  systemId: string | undefined;
  allowMutations: boolean;
}

export class RealADTClient implements SecurityProvider {
  readonly mode = "real" as const;
  private auth: AuthOpts | undefined;
  private authRead: Promise<AuthOpts> | undefined;
  private authExpiresAt = 0;
  private mutationDispatched = false;
  private mutationInFlight = false;
  private uncertainWrite = false;
  private selectedSystemId: string | undefined;

  get mutationsEnabled(): boolean { return this.config.allowMutations && !this.uncertainWrite; }
  get mutationWarning(): string | undefined {
    return this.uncertainWrite
      ? "Device control is disabled because a previous command has an uncertain outcome and may still complete. Do not retry it. Reconcile the operation in ADT before restarting this server."
      : undefined;
  }

  constructor(
    private readonly config: RealClientConfig,
    private readonly api: AlarmApi,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly fetchImpl: FetchLike = pinnedSnapshotFetch,
    private readonly lookupHost: LookupHost = (hostname) => lookup(hostname, { all: true, verbatim: true }),
  ) {}

  async getDashboard(): Promise<Omit<Dashboard, "recentActivity">> {
    const state = await this.getState();
    const dashboard = mapSystemState(state, this.mode, this.mutationsEnabled);
    if (this.mutationWarning) dashboard.system.mutationWarning = this.mutationWarning;
    return dashboard;
  }

  async execute(action: SecurityAction): Promise<OperationResult> {
    if (!this.mutationsEnabled) {
      throw new ADTError(
        "ACTION_NOT_ALLOWED",
        this.mutationWarning ?? "Real-device mutations are disabled. Set ADT_ALLOW_MUTATIONS=true in the host configuration after validating read-only access.",
      );
    }

    const parsed = SecurityActionSchema.safeParse(action);
    if (!parsed.success) throw new ADTError("ACTION_NOT_ALLOWED", "Security action is invalid.");
    if (this.mutationInFlight) throw new ADTError("ACTION_NOT_ALLOWED", "Another device command is still in progress.");
    this.mutationInFlight = true;
    this.mutationDispatched = false;
    const operationId = randomUUID();
    try {
      const before = await this.getState();
      const auth = await this.getAuth();
      try {
        await this.executeAgainstState(parsed.data, before, auth);
      } catch (error) {
        if (!this.mutationDispatched) throw error;
        // A rejected/timed-out transport promise cannot prove a physical write
        // did not happen. Never release another write into this uncertainty.
        this.uncertainWrite = true;
        return { operationId, status: "uncertain", summary: `${describeAction(action)} has an uncertain outcome.`, warning: this.mutationWarning! };
      }
      try {
        const verified = isActionSatisfied(action, mapDevices(await this.getState()));
        return {
          operationId,
          status: verified ? "completed" : "submitted",
          summary: verified ? `${describeAction(action)} completed and verified.` : `${describeAction(action)} was submitted but is not yet reflected in device state.`,
          ...(verified ? { verifiedAt: new Date().toISOString() } : {}),
        };
      } catch {
        return {
          operationId, status: "submitted", summary: `${describeAction(action)} was submitted; verification is unavailable.`,
          warning: "The command was accepted, but its resulting device state could not be read. Check ADT before retrying the action.",
        };
      }
    } finally { this.mutationInFlight = false; }
  }

  async getCameraSnapshot(cameraId: string): Promise<CameraSnapshot> {
    const auth = await this.getAuth();
    const state = await this.getState();
    const camera = state.cameras.find((item) => item.id === cameraId);
    if (!camera) throw new ADTError("DEVICE_NOT_FOUND", "Camera was not found in the selected ADT system.");
    if (!camera.attributes.canTakeSnapshot) throw new ADTError("ACTION_NOT_ALLOWED", "This camera does not support snapshots.");

    const signedUrl = await withTimeout(this.api.getCameraSnapshotUrl(cameraId, auth), this.timeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetchSnapshotResponse(signedUrl, controller.signal, this.fetchImpl, this.lookupHost);
      if (!response.ok) {
        await response.body?.cancel();
        throw new ADTError("UPSTREAM_ERROR", "ADT camera snapshot download failed.");
      }
      const mimeType = response.headers.get("content-type")?.split(";")[0] ?? "image/jpeg";
      if (!mimeType.startsWith("image/")) {
        await response.body?.cancel();
        throw new ADTError("UPSTREAM_ERROR", "ADT returned an invalid camera snapshot content type.");
      }
      const bytes = await readBoundedBody(response, MAX_SNAPSHOT_BYTES, controller.signal);
      return {
        cameraId,
        mimeType,
        data: Buffer.from(bytes).toString("base64"),
        bytes: bytes.byteLength,
        capturedAt: new Date().toISOString(),
      };
    } catch (error) {
      if (error instanceof ADTError) throw error;
      if (error instanceof Error && error.name === "AbortError") throw new ADTError("UPSTREAM_TIMEOUT", "Camera snapshot request timed out.");
      throw new ADTError("UPSTREAM_ERROR", "Camera snapshot request failed.");
    } finally {
      clearTimeout(timer);
    }
  }

  private async getAuth(): Promise<AuthOpts> {
    if (this.auth && this.authExpiresAt > Date.now()) return this.auth;
    if (this.authRead) return this.authRead;
    const read = this.login();
    this.authRead = read;
    try { return await read; }
    finally { if (this.authRead === read) this.authRead = undefined; }
  }

  private async login(): Promise<AuthOpts> {
    let auth: AuthOpts;
    try {
      const raw = await withTimeout(
        this.api.login(this.config.username, this.config.password, this.config.mfaToken),
        this.timeoutMs,
      );
      const expires = Math.min(
        Date.now() + AUTH_CACHE_MS,
        typeof raw.expires === "number" && Number.isFinite(raw.expires) ? raw.expires : Infinity,
      );
      auth = { ...raw, expires };
    } catch (error) {
      if (error instanceof ADTError) throw error;
      throw new ADTError("AUTHENTICATION_FAILED", "ADT authentication failed. Check the configured credentials and MFA token.");
    }

    const systems = auth.systems;
    if (this.config.systemId) {
      if (!systems.includes(this.config.systemId)) {
        this.auth = undefined;
        throw new ADTError("CONFIGURATION_ERROR", "ADT_SYSTEM_ID is not available to this account.");
      }
      this.selectedSystemId = this.config.systemId;
    } else if (systems.length === 1) {
      this.selectedSystemId = systems[0]!;
    } else if (systems.length > 1) {
      this.auth = undefined;
      throw new ADTError("AMBIGUOUS_SYSTEM", "This account has multiple systems. Set ADT_SYSTEM_ID explicitly.");
    } else {
      this.auth = undefined;
      throw new ADTError("AUTHENTICATION_FAILED", "No ADT systems are available to this account.");
    }
    this.auth = auth;
    this.authExpiresAt = auth.expires;
    return auth;
  }

  private async getState(retryAuthentication = true): Promise<FlattenedSystemState> {
    const auth = await this.getAuth();
    const systemId = this.selectedSystemId;
    if (!systemId) throw new ADTError("CONFIGURATION_ERROR", "No ADT system is selected.");
    try {
      return await withTimeout(this.api.getCurrentState(systemId, auth), this.timeoutMs);
    } catch (error) {
      // Read requests are safe to retry after authentication expiry. Writes are
      // never retried, because their effects may already have been applied.
      if (retryAuthentication && isAuthenticationError(error)) {
        this.auth = undefined;
        this.authExpiresAt = 0;
        return this.getState(false);
      }
      if (error instanceof ADTError) throw error;
      throw new ADTError("UPSTREAM_ERROR", "ADT device state could not be retrieved.");
    }
  }

  private async dispatchMutation(operation: () => Promise<unknown>): Promise<void> {
    this.mutationDispatched = true;
    await withTimeout(operation(), this.timeoutMs);
  }

  private async executeAgainstState(action: SecurityAction, state: FlattenedSystemState, auth: AuthOpts): Promise<void> {
    try {
      switch (action.type) {
        case "arm": {
          const panel = requireControllable(state.partitions, action.panelId, "Security panel");
          const options = { noEntryDelay: false, silentArming: false, nightArming: false, forceBypass: false };
          await this.dispatchMutation(() =>
            action.mode === "stay"
              ? this.api.armStay(panel.id, auth, options)
              : this.api.armAway(panel.id, auth, options),
          );
          return;
        }
        case "disarm": {
          const panel = requireControllable(state.partitions, action.panelId, "Security panel");
          await this.dispatchMutation(() => this.api.disarm(panel.id, auth));
          return;
        }
        case "lock": {
          const lock = requireControllable(state.locks, action.lockId, "Lock");
          await this.dispatchMutation(() =>
            action.locked ? this.api.setLockSecure(lock.id, auth) : this.api.setLockUnsecure(lock.id, auth),
          );
          return;
        }
        case "light": {
          const light = requireControllable(state.lights, action.lightId, "Light");
          const brightness = action.brightness ?? Math.max(1, light.attributes.lightLevel || 100);
          await this.dispatchMutation(() =>
            action.isOn
              ? this.api.setLightOn(light.id, auth, brightness, light.attributes.isDimmer)
              : this.api.setLightOff(light.id, auth, light.attributes.lightLevel, light.attributes.isDimmer),
          );
          return;
        }
        case "thermostat": {
          const thermostat = requireControllable(state.thermostats, action.thermostatId, "Thermostat");
          if (action.mode === "auto" && action.heatTarget >= action.coolTarget) {
            throw new ADTError("ACTION_NOT_ALLOWED", "Auto heat target must be lower than the cool target.");
          }
          const stateByMode = {
            off: THERMOSTAT_STATE.OFF,
            heat: THERMOSTAT_STATE.HEATING,
            cool: THERMOSTAT_STATE.COOLING,
            auto: THERMOSTAT_STATE.AUTO,
          } as const;
          await this.dispatchMutation(() => this.api.setThermostatState(thermostat.id, stateByMode[action.mode], auth));
          if (action.mode === "heat") {
            await this.dispatchMutation(() => this.api.setThermostatTargetHeatTemperature(thermostat.id, action.targetTemp, auth));
          } else if (action.mode === "cool") {
            await this.dispatchMutation(() => this.api.setThermostatTargetCoolTemperature(thermostat.id, action.targetTemp, auth));
          } else if (action.mode === "auto") {
            await this.dispatchMutation(() => this.api.setThermostatTargetHeatTemperature(thermostat.id, action.heatTarget, auth));
            await this.dispatchMutation(() => this.api.setThermostatTargetCoolTemperature(thermostat.id, action.coolTarget, auth));
          }
          return;
        }
      }
    } catch (error) {
      if (error instanceof ADTError) throw error;
      throw new ADTError("UPSTREAM_ERROR", `${actionLabel(action)} request failed at ADT.`);
    }
  }
}

export class DemoADTClient implements SecurityProvider {
  readonly mode = "demo" as const;
  readonly mutationsEnabled = true;
  private readonly devices: Device[] = createDemoDevices();

  async getDashboard(): Promise<Omit<Dashboard, "recentActivity">> {
    return dashboardFromDevices(this.devices, this.mode, this.mutationsEnabled);
  }

  async execute(action: SecurityAction): Promise<OperationResult> {
    const device = this.findTarget(action);
    switch (action.type) {
      case "arm":
        device.status = "armed";
        device.armMode = action.mode;
        break;
      case "disarm":
        device.status = "disarmed";
        delete device.armMode;
        break;
      case "lock":
        device.status = action.locked ? "locked" : "unlocked";
        break;
      case "light":
        device.status = action.isOn ? "on" : "off";
        if (action.isOn && action.brightness !== undefined) device.brightness = action.brightness;
        break;
      case "thermostat":
        if (action.mode === "auto" && action.heatTarget >= action.coolTarget) {
          throw new ADTError("ACTION_NOT_ALLOWED", "Auto heat target must be lower than the cool target.");
        }
        device.thermostatMode = action.mode;
        if (action.mode === "heat") device.heatTarget = action.targetTemp;
        if (action.mode === "cool") device.coolTarget = action.targetTemp;
        if (action.mode === "auto") {
          if (action.heatTarget >= action.coolTarget) throw new ADTError("ACTION_NOT_ALLOWED", "Auto heat target must be lower than the cool target.");
          device.heatTarget = action.heatTarget;
          device.coolTarget = action.coolTarget;
        }
        break;
    }
    device.lastUpdated = new Date().toISOString();
    return {
      operationId: randomUUID(),
      status: "completed",
      summary: `${describeAction(action)} completed in demo mode.`,
      verifiedAt: new Date().toISOString(),
    };
  }

  async getCameraSnapshot(cameraId: string): Promise<CameraSnapshot> {
    const camera = this.devices.find((device) => device.id === cameraId && device.type === "camera");
    if (!camera) throw new ADTError("DEVICE_NOT_FOUND", "Demo camera was not found.");
    throw new ADTError("ACTION_NOT_ALLOWED", "Demo mode does not fabricate camera imagery.");
  }

  private findTarget(action: SecurityAction): Device {
    const targetId = targetIdForAction(action);
    const device = this.devices.find((item) => item.id === targetId);
    if (!device) throw new ADTError("DEVICE_NOT_FOUND", "The requested demo device was not found.");
    return device;
  }
}

export function describeAction(action: SecurityAction): string {
  switch (action.type) {
    case "arm":
      return `Arm security panel ${action.panelId} in ${action.mode} mode`;
    case "disarm":
      return `Disarm security panel ${action.panelId}`;
    case "lock":
      return `${action.locked ? "Lock" : "Unlock"} door lock ${action.lockId}`;
    case "light":
      return `${action.isOn ? "Turn on" : "Turn off"} light ${action.lightId}${action.isOn && action.brightness ? ` at ${action.brightness}%` : ""}`;
    case "thermostat":
      return action.mode === "off"
        ? `Turn off thermostat ${action.thermostatId}`
        : action.mode === "auto"
          ? `Set thermostat ${action.thermostatId} to auto ${action.heatTarget}-${action.coolTarget}°F`
          : `Set thermostat ${action.thermostatId} to ${action.mode} at ${action.targetTemp}°F`;
  }
}

export function targetIdForAction(action: SecurityAction): string {
  switch (action.type) {
    case "arm":
    case "disarm":
      return action.panelId;
    case "lock":
      return action.lockId;
    case "light":
      return action.lightId;
    case "thermostat":
      return action.thermostatId;
  }
}

function mapSystemState(state: FlattenedSystemState, mode: "real", mutationsEnabled: boolean): Omit<Dashboard, "recentActivity"> {
  return dashboardFromDevices(mapDevices(state), mode, mutationsEnabled);
}

function dashboardFromDevices(devices: Device[], mode: "demo" | "real", mutationsEnabled: boolean): Omit<Dashboard, "recentActivity"> {
  const panels = devices.filter((device) => device.type === "panel");
  const armStatus = !panels.length || panels.some((panel) => !["armed", "disarmed"].includes(panel.status))
    ? "unknown" : panels.every((panel) => panel.status === "armed") ? "armed"
      : panels.every((panel) => panel.status === "disarmed") ? "disarmed" : "mixed";
  const armModes = new Set(panels.map((panel) => panel.armMode));
  const armMode = armStatus === "armed" && armModes.size === 1 ? panels[0]?.armMode : undefined;
  const critical = devices.some(isCriticalDevice);
  const warning = armStatus === "unknown" || devices.some((device) => device.status === "unknown" || device.status === "offline" || device.status === "triggered" || device.battery === "low");
  return {
    system: {
      mode,
      armed: armStatus === "unknown" || armStatus === "mixed" ? null : armStatus === "armed",
      armStatus,
      ...(armMode ? { armMode } : {}),
      health: critical ? "critical" : warning ? "warning" : "healthy",
      connectedDevices: devices.filter((device) => device.status !== "offline" && device.status !== "unknown").length,
      totalDevices: devices.length,
      mutationsEnabled,
    },
    devices: devices.map((device) => ({ ...device })),
    refreshedAt: new Date().toISOString(),
  };
}

function mapDevices(state: FlattenedSystemState): Device[] {
  const timestamp = new Date().toISOString();
  const devices: Device[] = [];

  for (const panel of state.partitions) {
    const stateAvailable = panel.attributes.hasState !== false;
    const armMode = !stateAvailable ? undefined : panel.attributes.state === SYSTEM_STATE.ARMED_STAY
      ? "stay"
      : panel.attributes.state === SYSTEM_STATE.ARMED_AWAY
        ? "away"
        : panel.attributes.state === SYSTEM_STATE.ARMED_NIGHT
          ? "night"
          : undefined;
    devices.push({
      id: panel.id,
      name: panel.attributes.description || "Security Panel",
      type: "panel",
      status: !stateAvailable ? "unknown" : armMode ? "armed" : panel.attributes.state === SYSTEM_STATE.DISARMED ? "disarmed" : "unknown",
      lastUpdated: timestamp,
      capabilities: panel.attributes.hasPermissionToChangeState ? ["arm", "disarm"] : [],
      ...(armMode ? { armMode } : {}),
      battery: batteryState(panel.attributes),
    });
  }

  for (const sensor of state.sensors) {
    const triggered = sensor.attributes.state === SENSOR_STATE.OPEN
      || sensor.attributes.state === SENSOR_STATE.ACTIVE
      || sensor.attributes.state === SENSOR_STATE.WET;
    devices.push({
      id: sensor.id,
      name: sensor.attributes.description || "Sensor",
      type: "sensor",
      status: !sensor.attributes.hasState ? "offline" : triggered ? "triggered" : "online",
      lastUpdated: timestamp,
      capabilities: [],
      triggered,
      sensorType: mapSensorType(sensor.attributes.deviceType),
      battery: batteryState(sensor.attributes),
    });
  }

  for (const lock of state.locks) {
    devices.push({
      id: lock.id,
      name: lock.attributes.description || "Lock",
      type: "lock",
      status: lock.attributes.state === LOCK_STATE.SECURED ? "locked" : lock.attributes.state === LOCK_STATE.UNSECURED ? "unlocked" : "unknown",
      lastUpdated: timestamp,
      capabilities: lock.attributes.hasPermissionToChangeState ? ["lock", "unlock"] : [],
      battery: batteryState(lock.attributes),
    });
  }

  for (const light of state.lights) {
    devices.push({
      id: light.id,
      name: light.attributes.description || "Light",
      type: "light",
      status: light.attributes.state === LIGHT_STATE.ON ? "on" : light.attributes.state === LIGHT_STATE.OFF ? "off" : "unknown",
      lastUpdated: timestamp,
      capabilities: light.attributes.hasPermissionToChangeState ? ["on", "off", ...(light.attributes.isDimmer ? ["brightness"] : [])] : [],
      brightness: Math.max(0, Math.min(100, light.attributes.lightLevel)),
      isDimmer: light.attributes.isDimmer,
      battery: batteryState(light.attributes),
    });
  }

  for (const thermostat of state.thermostats) {
    const mode = thermostat.attributes.state === THERMOSTAT_STATE.OFF
      ? "off"
      : thermostat.attributes.state === THERMOSTAT_STATE.HEATING
        ? "heat"
        : thermostat.attributes.state === THERMOSTAT_STATE.COOLING
          ? "cool"
          : thermostat.attributes.state === THERMOSTAT_STATE.AUTO
            ? "auto"
            : "unknown";
    devices.push({
      id: thermostat.id,
      name: thermostat.attributes.description || "Thermostat",
      type: "thermostat",
      status: thermostat.attributes.hasState && !thermostat.attributes.isMalfunctioning ? "online" : "offline",
      lastUpdated: timestamp,
      capabilities: thermostat.attributes.hasPermissionToChangeState ? ["mode", "temperature"] : [],
      currentTemp: thermostat.attributes.ambientTemp,
      heatTarget: thermostat.attributes.heatSetpoint,
      coolTarget: thermostat.attributes.coolSetpoint,
      thermostatMode: mode,
      ...(thermostat.attributes.humidityLevel !== undefined ? { humidity: thermostat.attributes.humidityLevel } : {}),
      battery: batteryState(thermostat.attributes),
    });
  }

  for (const camera of state.cameras) {
    devices.push({
      id: camera.id,
      name: camera.attributes.description || "Camera",
      type: "camera",
      status: camera.attributes.isUnreachable ? "offline" : "online",
      lastUpdated: timestamp,
      capabilities: camera.attributes.canTakeSnapshot ? ["snapshot"] : [],
      canTakeSnapshot: camera.attributes.canTakeSnapshot,
      battery: batteryState(camera.attributes),
    });
  }

  return devices;
}

function batteryState(attributes: { lowBattery?: boolean; criticalBattery?: boolean }): "normal" | "low" | "critical" | "unknown" {
  if (attributes.criticalBattery) return "critical";
  if (attributes.lowBattery) return "low";
  return "normal";
}

function mapSensorType(type: SensorType): Device["sensorType"] {
  switch (type) {
    case SensorType.Contact_Sensor:
      return "contact";
    case SensorType.Motion_Sensor:
      return "motion";
    case SensorType.Smoke_Detector:
      return "smoke";
    case SensorType.CO_Detector:
      return "carbon-monoxide";
    case SensorType.Heat_Detector:
      return "heat";
    case SensorType.Water_Sensor:
      return "water";
    case SensorType.Glass_Break:
    case SensorType.Panel_Glass_Break:
      return "glass-break";
    default:
      return "other";
  }
}

function requireControllable<T extends { id: string; attributes: { hasPermissionToChangeState: boolean; remoteCommandsEnabled: boolean } }>(
  devices: T[],
  id: string,
  label: string,
): T {
  const device = devices.find((candidate) => candidate.id === id);
  if (!device) throw new ADTError("DEVICE_NOT_FOUND", `${label} was not found in the selected ADT system.`);
  if (!device.attributes.hasPermissionToChangeState || !device.attributes.remoteCommandsEnabled) {
    throw new ADTError("ACTION_NOT_ALLOWED", `${label} does not permit remote control.`);
  }
  return device;
}

function isActionSatisfied(action: SecurityAction, devices: Device[]): boolean {
  const device = devices.find((candidate) => candidate.id === targetIdForAction(action));
  if (!device) return false;
  switch (action.type) {
    case "arm":
      return device.status === "armed" && device.armMode === action.mode;
    case "disarm":
      return device.status === "disarmed";
    case "lock":
      return device.status === (action.locked ? "locked" : "unlocked");
    case "light":
      return device.status === (action.isOn ? "on" : "off") && (!action.isOn || action.brightness === undefined || device.brightness === action.brightness);
    case "thermostat":
      if (device.thermostatMode !== action.mode) return false;
      if (action.mode === "heat") return device.heatTarget === action.targetTemp;
      if (action.mode === "cool") return device.coolTarget === action.targetTemp;
      if (action.mode === "auto") return device.heatTarget === action.heatTarget && device.coolTarget === action.coolTarget;
      return true;
  }
}

function createDemoDevices(): Device[] {
  const now = new Date().toISOString();
  return [
    { id: "panel-1", name: "Security Panel", type: "panel", status: "disarmed", lastUpdated: now, capabilities: ["arm", "disarm"], battery: "normal" },
    { id: "camera-1", name: "Front Door Camera", type: "camera", status: "online", lastUpdated: now, capabilities: [], canTakeSnapshot: false, battery: "normal" },
    { id: "sensor-1", name: "Front Door", type: "sensor", status: "online", lastUpdated: now, capabilities: [], triggered: false, sensorType: "contact", battery: "normal" },
    { id: "lock-1", name: "Front Door Lock", type: "lock", status: "locked", lastUpdated: now, capabilities: ["lock", "unlock"], battery: "normal" },
    { id: "light-1", name: "Front Porch Light", type: "light", status: "on", lastUpdated: now, capabilities: ["on", "off", "brightness"], brightness: 100, isDimmer: true, battery: "normal" },
    { id: "thermostat-1", name: "Thermostat", type: "thermostat", status: "online", lastUpdated: now, capabilities: ["mode", "temperature"], currentTemp: 72, heatTarget: 68, coolTarget: 74, thermostatMode: "auto", humidity: 45, battery: "normal" },
  ];
}

function isAuthenticationError(error: unknown): boolean {
  return error instanceof Error && /(?:status=|statusCode[=: ]|HTTP\s+)401\b/i.test(error.message);
}

function actionLabel(action: SecurityAction): string {
  return action.type === "lock" ? (action.locked ? "Lock" : "Unlock") : action.type[0]!.toUpperCase() + action.type.slice(1);
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ADTError("UPSTREAM_TIMEOUT", "ADT request timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchSnapshotResponse(
  initialUrl: string,
  signal: AbortSignal,
  fetchImpl: FetchLike,
  lookupHost: LookupHost,
): Promise<Response> {
  let currentUrl: URL;
  try {
    currentUrl = new URL(initialUrl);
  } catch {
    throw new ADTError("UPSTREAM_ERROR", "ADT returned an invalid camera snapshot URL.");
  }

  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const addresses = await abortable(validateSnapshotUrl(currentUrl, lookupHost), signal);
    const response = await abortable(fetchImpl(currentUrl, { signal, redirect: "manual" }, addresses), signal);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location || redirects === 3) throw new ADTError("UPSTREAM_ERROR", "ADT camera snapshot redirected too many times or without a destination.");
    try {
      currentUrl = new URL(location, currentUrl);
    } catch {
      throw new ADTError("UPSTREAM_ERROR", "ADT camera snapshot returned an invalid redirect URL.");
    }
  }
  throw new ADTError("UPSTREAM_ERROR", "ADT camera snapshot redirected too many times.");
}

async function validateSnapshotUrl(url: URL, lookupHost: LookupHost): Promise<PublicAddress[]> {
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new ADTError("UPSTREAM_ERROR", "ADT camera snapshot URL must use credential-free HTTPS.");
  }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new ADTError("UPSTREAM_ERROR", "ADT camera snapshot URL is not a permitted public destination.");
  }
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookupHost(hostname);
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new ADTError("UPSTREAM_ERROR", "ADT camera snapshot URL is not a permitted public destination.");
  }
  return addresses;
}

// Connect to a validated IP directly; retain the URL hostname for Host, SNI,
// and certificate verification. No second DNS lookup or pooled connection.
export function pinnedSnapshotRequestOptions(url: URL, address: PublicAddress, signal?: AbortSignal): RequestOptions {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return {
    hostname: address.address, family: address.family, port: url.port || 443,
    path: `${url.pathname}${url.search}`, method: "GET", agent: false,
    headers: { Host: url.host },
    ...(isIP(hostname) ? {} : { servername: hostname }),
    checkServerIdentity: (_servername, certificate) => checkServerIdentity(hostname, certificate),
    ...(signal ? { signal } : {}),
  };
}

async function pinnedSnapshotFetch(input: string | URL, init?: RequestInit, addresses?: PublicAddress[]): Promise<Response> {
  const address = addresses?.[0];
  if (!address) throw new ADTError("UPSTREAM_ERROR", "Camera snapshot has no validated destination.");
  const url = new URL(input);
  return new Promise((resolve, reject) => {
    const request = httpsRequest(pinnedSnapshotRequestOptions(url, address, init?.signal ?? undefined), (response) => {
      try {
      const headers = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      const status = response.statusCode ?? 502;
      if ([204, 205, 304].includes(status)) {
        response.resume();
        resolve(new Response(null, { status, headers }));
      } else {
        resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers }));
      }
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    request.once("error", reject);
    request.end();
  });
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new DOMException("Snapshot deadline exceeded.", "AbortError"));
    if (signal.aborted) { promise.catch(() => undefined); aborted(); return; }
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted)).catch(() => undefined);
  });
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().split("%")[0]!;
  if (normalized.startsWith("::ffff:")) return isPrivateAddress(normalized.slice("::ffff:".length));
  if (isIP(normalized) === 6) {
    return !(normalized.startsWith("2") || normalized.startsWith("3"))
      || normalized.startsWith("2001:db8") || normalized.startsWith("2001:10");
  }
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 0 && (c === 0 || c === 2))
    || (a === 192 && b === 168)
    || (a === 198 && (b === 18 || b === 19))
    || (a === 198 && b === 51 && c === 100)
    || (a === 203 && b === 0 && c === 113);
}

async function readBoundedBody(response: Response, maxBytes: number, signal: AbortSignal): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel();
    throw new ADTError("SNAPSHOT_TOO_LARGE", "Camera snapshot exceeds the 5 MB safety limit.");
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel();
        throw new ADTError("SNAPSHOT_TOO_LARGE", "Camera snapshot exceeds the 5 MB safety limit.");
      }
      chunks.push(value);
    }
  } finally {
    if (signal.aborted) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const output = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
