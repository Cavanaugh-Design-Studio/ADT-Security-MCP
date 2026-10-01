import assert from "node:assert/strict";
import { mkdtemp, mkdir, rmdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { AuthOpts, FlattenedSystemState } from "node-alarm-dot-com";
import { ADTError, RealADTClient, type AlarmApi } from "../src/adt-client.js";
import { JsonlAuditLog, MemoryAuditLog } from "../src/audit-log.js";
import { SecurityService } from "../src/security-service.js";
import { deriveDeviceAlerts } from "../src/device-alerts.js";
import { DashboardSchema, OperationResultSchema } from "../src/types.js";

const config = { username: "mock", password: "mock", mfaToken: undefined, systemId: undefined, allowMutations: true };
const unlock = { type: "lock", lockId: "lock-1", locked: false } as const;
const lock = { ...unlock, locked: true };

function fixture() {
  const state = {
    partitions: [{ id: "panel-1", attributes: { description: "Main", state: 1, hasState: true, hasPermissionToChangeState: true, remoteCommandsEnabled: true } }],
    sensors: [], lights: [], cameras: [], thermostats: [],
    locks: [{ id: "lock-1", attributes: { description: "Mock lock", state: 1, hasState: true, hasPermissionToChangeState: true, remoteCommandsEnabled: true } }],
  } as unknown as FlattenedSystemState;
  const api: AlarmApi = {
    // Match the upstream runtime shape, which does not provide expires.
    login: async () => ({ cookie: "mock", ajaxKey: "mock", systems: ["s1"], identities: {} as AuthOpts["identities"] }),
    getCurrentState: async () => structuredClone(state),
    armStay: async () => undefined, armAway: async () => undefined, disarm: async () => undefined,
    setLockUnsecure: async () => { state.locks[0]!.attributes.state = 2; },
    setLockSecure: async () => { state.locks[0]!.attributes.state = 1; },
    setLightOn: async () => undefined, setLightOff: async () => undefined,
    setThermostatState: async () => undefined,
    setThermostatTargetHeatTemperature: async () => undefined,
    setThermostatTargetCoolTemperature: async () => undefined,
    getCameraSnapshotUrl: async () => "https://mock.invalid/snapshot",
  };
  return { state, api };
}

test("upstream-shaped auth is cached and simultaneous logins are coalesced", async () => {
  const { api } = fixture(); let logins = 0;
  const login = api.login;
  api.login = async (...args) => { logins++; await new Promise((resolve) => setTimeout(resolve, 5)); return login(...args); };
  const provider = new RealADTClient(config, api, 1_000);
  await Promise.all([provider.getDashboard(), provider.getDashboard()]);
  await provider.getDashboard();
  await provider.execute(unlock);
  assert.equal(logins, 1);
});

test("expired authentication is refreshed for a read without retrying physical commands", async () => {
  const { api } = fixture(); let logins = 0;
  const login = api.login;
  api.login = async (...args) => { logins++; return login(...args); };
  const read = api.getCurrentState; let reads = 0;
  api.getCurrentState = async (...args) => { if (++reads === 2) throw new Error("GET failed: status=401"); return read(...args); };
  const provider = new RealADTClient(config, api, 1_000);
  await provider.getDashboard(); await provider.getDashboard();
  assert.equal(logins, 2); assert.equal(reads, 3);
});

test("successful unlock plus failed verification remains submitted in the audit", async () => {
  const { state, api } = fixture(); const read = api.getCurrentState; let reads = 0;
  api.getCurrentState = async (...args) => { if (++reads === 3) throw new Error("mock read outage"); return read(...args); };
  const audit = new MemoryAuditLog(); const service = new SecurityService(new RealADTClient(config, api, 1_000), audit);
  const confirmation = await service.prepare(unlock); const result = await service.commit(confirmation.token, unlock);
  assert.equal(state.locks[0]!.attributes.state, 2);
  assert.equal(result.status, "submitted"); assert.match(result.warning ?? "", /before retrying/);
  assert.equal(audit.entries[0]?.outcome, "submitted"); assert.ok(OperationResultSchema.safeParse(result).success);
});

test("timed-out unlock prevents preconfirmed relock, including after late completion", async () => {
  const { state, api } = fixture(); let finishUnlock!: () => void; let relocks = 0;
  api.setLockUnsecure = () => new Promise((resolve) => { finishUnlock = () => { state.locks[0]!.attributes.state = 2; resolve(undefined); }; });
  api.setLockSecure = async () => { relocks++; state.locks[0]!.attributes.state = 1; };
  const provider = new RealADTClient(config, api, 20); const audit = new MemoryAuditLog(); const service = new SecurityService(provider, audit);
  const first = await service.prepare(unlock); const second = await service.prepare(lock);
  const result = await service.commit(first.token, unlock);
  assert.equal(result.status, "uncertain"); assert.equal(audit.entries[0]?.outcome, "uncertain");
  await assert.rejects(service.commit(second.token, lock), (error: unknown) => error instanceof ADTError && error.code === "ACTION_NOT_ALLOWED");
  assert.equal(relocks, 0);
  finishUnlock(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(state.locks[0]!.attributes.state, 2); assert.equal(provider.mutationsEnabled, false);
  await assert.rejects(service.prepare(lock), /uncertain outcome/);
  const dashboard = await service.getDashboard();
  assert.equal(dashboard.system.mutationsEnabled, false); assert.match(dashboard.system.mutationWarning ?? "", /Do not retry/);
});

test("partial thermostat writes report uncertainty and block further writes", async () => {
  const { state, api } = fixture(); let mode = 1; let heatWrites = 0;
  state.thermostats.push({ id: "t1", attributes: { state: 1, hasState: true, hasPermissionToChangeState: true, remoteCommandsEnabled: true, isMalfunctioning: false, ambientTemp: 72, heatSetpoint: 68, coolSetpoint: 74 } } as FlattenedSystemState["thermostats"][number]);
  api.setThermostatState = async (_id, desired) => { mode = desired; };
  api.setThermostatTargetHeatTemperature = async () => { heatWrites++; throw new Error("mock POST failed: status=401"); };
  const provider = new RealADTClient(config, api, 1_000);
  const result = await provider.execute({ type: "thermostat", thermostatId: "t1", mode: "heat", targetTemp: 70 });
  assert.equal(mode, 2); assert.equal(heatWrites, 1); assert.equal(result.status, "uncertain");
  await assert.rejects(provider.execute(lock), /uncertain outcome/);
});

test("unknown, unavailable, missing, and mixed partitions never imply disarmed healthy", async () => {
  const { state, api } = fixture(); const provider = new RealADTClient(config, api, 1_000);
  state.partitions[0]!.attributes.state = 999 as FlattenedSystemState["partitions"][number]["attributes"]["state"];
  let dashboard = await provider.getDashboard();
  assert.equal(dashboard.system.armed, null); assert.equal(dashboard.system.armStatus, "unknown"); assert.equal(dashboard.system.health, "warning");
  assert.equal(deriveDeviceAlerts(dashboard.devices, dashboard.refreshedAt, 20)[0]?.severity, "warning");
  state.partitions[0]!.attributes.state = 3; state.partitions[0]!.attributes.hasState = false;
  assert.equal((await provider.getDashboard()).devices[0]?.status, "unknown");
  state.partitions[0]!.attributes.state = 1; state.partitions[0]!.attributes.hasState = true;
  state.partitions.push({ ...structuredClone(state.partitions[0]!), id: "panel-2", attributes: { ...state.partitions[0]!.attributes, state: 3 } });
  dashboard = await provider.getDashboard();
  assert.equal(dashboard.system.armStatus, "mixed"); assert.equal(dashboard.system.armed, null); assert.equal(dashboard.devices.filter((d) => d.type === "panel").length, 2);
  assert.ok(DashboardSchema.safeParse({ ...dashboard, recentActivity: [] }).success);
  state.partitions.length = 0;
  assert.equal((await provider.getDashboard()).system.armStatus, "unknown");
});

test("audit history recovers from failed append after file access is repaired", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "adt-audit-regression-"));
  const logPath = path.join(directory, "audit.jsonl");
  try {
    const audit = new JsonlAuditLog(logPath);
    await audit.append({ mode: "demo", actionType: "lock", targetId: "mock", summary: "previous", outcome: "completed", durationMs: 0 });
    // Rename away the valid log, obstruct its location with a directory, then repair it.
    const { rename } = await import("node:fs/promises");
    await rename(logPath, `${logPath}.saved`); await mkdir(logPath);
    await assert.rejects(audit.append({ mode: "demo", actionType: "lock", targetId: "mock", summary: "failed", outcome: "submitted", durationMs: 0 }));
    await rmdir(logPath); await rename(`${logPath}.saved`, logPath);
    assert.equal((await audit.list(20))[0]?.summary, "previous");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
