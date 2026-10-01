import assert from "node:assert/strict";
import test from "node:test";
import { DemoADTClient } from "../src/adt-client.js";
import { MemoryAuditLog } from "../src/audit-log.js";
import type { AuditLog } from "../src/audit-log.js";
import { SecurityService, ServiceError } from "../src/security-service.js";
import { isCriticalDevice, type SecurityAction, type SecurityProvider } from "../src/types.js";

test("demo actions require confirmation, update state, and append a redacted audit entry", async () => {
  const provider = new DemoADTClient();
  const audit = new MemoryAuditLog();
  const service = new SecurityService(provider, audit);
  const action = { type: "lock", lockId: "lock-1", locked: false } as const;

  const confirmation = await service.prepare(action);
  const result = await service.commit(confirmation.token, action);
  const dashboard = await service.getDashboard();

  assert.equal(result.status, "completed");
  assert.equal(result.auditRecorded, true);
  assert.equal(dashboard.devices.find((device) => device.id === "lock-1")?.status, "unlocked");
  assert.equal(dashboard.recentActivity.length, 1);
  assert.equal(dashboard.recentActivity[0]?.actionType, "lock");
  assert.equal(dashboard.recentActivity[0]?.targetId, "lock-1");
  assert.equal(JSON.stringify(dashboard.recentActivity).includes("token"), false);
});

test("invalid thermostat auto targets are rejected before any side effect", async () => {
  const provider = new DemoADTClient();
  const service = new SecurityService(provider, new MemoryAuditLog());
  const off = { type: "thermostat", thermostatId: "thermostat-1", mode: "off" } as const;
  const offConfirmation = await service.prepare(off);
  await service.commit(offConfirmation.token, off);

  await assert.rejects(
    service.prepare({ type: "thermostat", thermostatId: "thermostat-1", mode: "auto", heatTarget: 78, coolTarget: 70 }),
    (error: unknown) => error instanceof ServiceError && error.code === "INVALID_ACTION",
  );
  const dashboard = await service.getDashboard();
  assert.equal(dashboard.devices.find((device) => device.id === "thermostat-1")?.thermostatMode, "off");
});

test("successful actions remain successful when the audit log is unavailable", async () => {
  const provider = new DemoADTClient();
  const audit: AuditLog = {
    append: async () => { throw new Error("disk unavailable"); },
    list: async () => [],
  };
  const service = new SecurityService(provider, audit);
  const action = { type: "lock", lockId: "lock-1", locked: false } as const;
  const confirmation = await service.prepare(action);
  const originalConsoleError = console.error;
  console.error = () => undefined;
  try {
    const result = await service.commit(confirmation.token, action);
    assert.equal(result.status, "completed");
    assert.equal(result.auditRecorded, false);
    assert.match(result.warning ?? "", /Do not retry/);
  } finally {
    console.error = originalConsoleError;
  }
});

test("simultaneous reads are coalesced and physical mutations are serialized", async () => {
  const demo = new DemoADTClient();
  let reads = 0;
  let activeMutations = 0;
  let maxActiveMutations = 0;
  const provider: SecurityProvider = {
    mode: "demo",
    mutationsEnabled: true,
    getDashboard: async () => {
      reads += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return demo.getDashboard();
    },
    execute: async (action: SecurityAction) => {
      activeMutations += 1;
      maxActiveMutations = Math.max(maxActiveMutations, activeMutations);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await demo.execute(action);
      } finally {
        activeMutations -= 1;
      }
    },
    getCameraSnapshot: (cameraId) => demo.getCameraSnapshot(cameraId),
  };
  const service = new SecurityService(provider, new MemoryAuditLog());
  await Promise.all([service.getDashboard(), service.getAlerts(20)]);
  assert.equal(reads, 1);

  const unlock = { type: "lock", lockId: "lock-1", locked: false } as const;
  const lightOff = { type: "light", lightId: "light-1", isOn: false } as const;
  const [unlockConfirmation, lightConfirmation] = await Promise.all([service.prepare(unlock), service.prepare(lightOff)]);
  await Promise.all([
    service.commit(unlockConfirmation.token, unlock),
    service.commit(lightConfirmation.token, lightOff),
  ]);
  assert.equal(maxActiveMutations, 1);
});

test("critical alerts are prioritized and carbon-monoxide triggers share the critical-health rule", async () => {
  const demo = new DemoADTClient();
  const base = await demo.getDashboard();
  const provider: SecurityProvider = {
    mode: "demo",
    mutationsEnabled: true,
    getDashboard: async () => ({
      ...base,
      devices: [
        { id: "warning", name: "Offline sensor", type: "sensor", status: "offline", lastUpdated: base.refreshedAt, capabilities: [], battery: "normal" },
        { id: "critical", name: "CO detector", type: "sensor", status: "triggered", lastUpdated: base.refreshedAt, capabilities: [], triggered: true, sensorType: "carbon-monoxide", battery: "normal" },
      ],
      system: { ...base.system, health: "critical", connectedDevices: 1, totalDevices: 2 },
    }),
    execute: (action) => demo.execute(action),
    getCameraSnapshot: (cameraId) => demo.getCameraSnapshot(cameraId),
  };
  const service = new SecurityService(provider, new MemoryAuditLog());
  const alerts = await service.getAlerts(1);
  assert.equal(alerts[0]?.severity, "critical");
  assert.equal(alerts[0]?.deviceId, "critical");
  assert.equal(isCriticalDevice((await provider.getDashboard()).devices[1]!), true);
});

test("prepare rejects nonexistent and incompatible targets", async () => {
  const service = new SecurityService(new DemoADTClient(), new MemoryAuditLog());
  await assert.rejects(
    service.prepare({ type: "disarm", panelId: "lock-1" }),
    (error: unknown) => error instanceof ServiceError && error.code === "INVALID_TARGET",
  );
});

test("prepare enforces brightness and thermostat temperature capabilities", async () => {
  const demo = new DemoADTClient();
  const provider: SecurityProvider = {
    mode: "demo",
    mutationsEnabled: true,
    getDashboard: async () => {
      const dashboard = await demo.getDashboard();
      return {
        ...dashboard,
        devices: dashboard.devices.map((device) => device.id === "light-1"
          ? { ...device, capabilities: ["on", "off"] }
          : device.id === "thermostat-1"
            ? { ...device, capabilities: ["mode"] }
            : device),
      };
    },
    execute: (action) => demo.execute(action),
    getCameraSnapshot: (cameraId) => demo.getCameraSnapshot(cameraId),
  };
  const service = new SecurityService(provider, new MemoryAuditLog());
  await assert.rejects(
    service.prepare({ type: "light", lightId: "light-1", isOn: true, brightness: 50 }),
    (error: unknown) => error instanceof ServiceError && error.code === "INVALID_TARGET",
  );
  await assert.rejects(
    service.prepare({ type: "thermostat", thermostatId: "thermostat-1", mode: "heat", targetTemp: 68 }),
    (error: unknown) => error instanceof ServiceError && error.code === "INVALID_TARGET",
  );
});

test("real providers remain read-only unless mutations are explicitly enabled", async () => {
  const demo = new DemoADTClient();
  const readOnlyProvider: SecurityProvider = {
    mode: "real",
    mutationsEnabled: false,
    getDashboard: () => demo.getDashboard(),
    execute: (action) => demo.execute(action),
    getCameraSnapshot: (cameraId) => demo.getCameraSnapshot(cameraId),
  };
  const service = new SecurityService(readOnlyProvider, new MemoryAuditLog());

  await assert.rejects(
    service.prepare({ type: "arm", panelId: "panel-1", mode: "away" }),
    (error: unknown) => error instanceof ServiceError && error.code === "MUTATIONS_DISABLED",
  );
});
