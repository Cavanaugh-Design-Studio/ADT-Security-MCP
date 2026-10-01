import assert from "node:assert/strict";
import test from "node:test";
import type { AuthOpts, FlattenedSystemState } from "node-alarm-dot-com";
import { ADTError, RealADTClient, type AlarmApi } from "../src/adt-client.js";

test("real provider maps panel state, calls the exact upstream arm method, and verifies refreshed state", async () => {
  const auth = {
    cookie: "redacted",
    ajaxKey: "redacted",
    expires: Date.now() + 60_000,
    systems: ["system-1"],
    identities: {},
  } as AuthOpts;
  const state = {
    id: 1,
    attributes: {},
    partitions: [{
      id: "partition-1",
      attributes: {
        description: "Main panel",
        state: 1,
        hasPermissionToChangeState: true,
        remoteCommandsEnabled: true,
        lowBattery: false,
        criticalBattery: false,
      },
    }],
    sensors: [],
    lights: [],
    locks: [],
    garages: [],
    thermostats: [],
    cameras: [],
    relationships: {},
  } as unknown as FlattenedSystemState;
  let armAwayCalls = 0;
  const api: AlarmApi = {
    login: async () => auth,
    getCurrentState: async () => state,
    armStay: async () => undefined,
    armAway: async () => {
      armAwayCalls += 1;
      state.partitions[0]!.attributes.state = 3;
    },
    disarm: async () => undefined,
    setLockSecure: async () => undefined,
    setLockUnsecure: async () => undefined,
    setLightOn: async () => undefined,
    setLightOff: async () => undefined,
    setThermostatState: async () => undefined,
    setThermostatTargetHeatTemperature: async () => undefined,
    setThermostatTargetCoolTemperature: async () => undefined,
    getCameraSnapshotUrl: async () => "https://invalid.test/snapshot.jpg",
  };
  const provider = new RealADTClient({
    username: "user",
    password: "password",
    mfaToken: undefined,
    systemId: undefined,
    allowMutations: true,
  }, api, 1_000);

  const before = await provider.getDashboard();
  assert.equal(before.devices[0]?.status, "disarmed");
  const result = await provider.execute({ type: "arm", panelId: "partition-1", mode: "away" });
  const after = await provider.getDashboard();

  assert.equal(armAwayCalls, 1);
  assert.equal(result.status, "completed");
  assert.equal(after.devices[0]?.status, "armed");
  assert.equal(after.devices[0]?.armMode, "away");
});

test("real provider validates thermostat auto targets before any upstream mutation", async () => {
  const auth = {
    cookie: "redacted",
    ajaxKey: "redacted",
    expires: Date.now() + 60_000,
    systems: ["system-1"],
    identities: {},
  } as AuthOpts;
  const state = {
    id: 1,
    attributes: {},
    partitions: [], sensors: [], lights: [], locks: [], garages: [], cameras: [], relationships: {},
    thermostats: [{
      id: "thermostat-1",
      attributes: {
        description: "Thermostat",
        state: 1,
        hasState: true,
        isMalfunctioning: false,
        hasPermissionToChangeState: true,
        remoteCommandsEnabled: true,
        ambientTemp: 72,
        heatSetpoint: 68,
        coolSetpoint: 74,
        lowBattery: false,
        criticalBattery: false,
      },
    }],
  } as unknown as FlattenedSystemState;
  let thermostatStateCalls = 0;
  const api: AlarmApi = {
    login: async () => auth,
    getCurrentState: async () => state,
    armStay: async () => undefined,
    armAway: async () => undefined,
    disarm: async () => undefined,
    setLockSecure: async () => undefined,
    setLockUnsecure: async () => undefined,
    setLightOn: async () => undefined,
    setLightOff: async () => undefined,
    setThermostatState: async () => { thermostatStateCalls += 1; },
    setThermostatTargetHeatTemperature: async () => undefined,
    setThermostatTargetCoolTemperature: async () => undefined,
    getCameraSnapshotUrl: async () => "https://invalid.test/snapshot.jpg",
  };
  const provider = new RealADTClient({
    username: "user", password: "password", mfaToken: undefined, systemId: undefined, allowMutations: true,
  }, api, 1_000);

  await assert.rejects(
    provider.execute({ type: "thermostat", thermostatId: "thermostat-1", mode: "auto", heatTarget: 78, coolTarget: 70 }),
    (error: unknown) => error instanceof ADTError && error.code === "ACTION_NOT_ALLOWED",
  );
  assert.equal(thermostatStateCalls, 0);
});
