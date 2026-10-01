import assert from "node:assert/strict";
import test from "node:test";
import type { DetailedPeerCertificate } from "node:tls";
import type { AuthOpts, FlattenedSystemState } from "node-alarm-dot-com";
import { ADTError, RealADTClient, pinnedSnapshotRequestOptions, type AlarmApi, type RealClientConfig } from "../src/adt-client.js";

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
  partitions: [],
  sensors: [],
  lights: [],
  locks: [],
  garages: [],
  thermostats: [],
  cameras: [{
    id: "camera-1",
    attributes: {
      description: "Camera",
      canTakeSnapshot: true,
      isUnreachable: false,
      lowBattery: false,
      criticalBattery: false,
    },
  }],
  relationships: {},
} as unknown as FlattenedSystemState;

const config: RealClientConfig = {
  username: "user",
  password: "password",
  mfaToken: undefined,
  systemId: undefined,
  allowMutations: false,
};

test("camera snapshots reject redirects to private destinations", async () => {
  let fetchCalls = 0;
  const provider = createProvider(
    async () => {
      fetchCalls += 1;
      return new Response(null, { status: 302, headers: { Location: "https://127.0.0.1/private.jpg" } });
    },
  );

  await assert.rejects(
    provider.getCameraSnapshot("camera-1"),
    (error: unknown) => error instanceof ADTError && error.code === "UPSTREAM_ERROR" && /public destination/.test(error.message),
  );
  assert.equal(fetchCalls, 1);
});

test("camera snapshots stream with a hard five-megabyte bound", async () => {
  const oversized = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(3 * 1024 * 1024));
      controller.enqueue(new Uint8Array(3 * 1024 * 1024));
      controller.close();
    },
  });
  const provider = createProvider(async () => new Response(oversized, {
    status: 200,
    headers: { "Content-Type": "image/jpeg" },
  }));

  await assert.rejects(
    provider.getCameraSnapshot("camera-1"),
    (error: unknown) => error instanceof ADTError && error.code === "SNAPSHOT_TOO_LARGE",
  );
});

test("camera snapshots accept bounded public HTTPS image responses", async () => {
  const provider = createProvider(async () => new Response(new Uint8Array([1, 2, 3]), {
    status: 200,
    headers: { "Content-Type": "image/png" },
  }));
  const snapshot = await provider.getCameraSnapshot("camera-1");
  assert.equal(snapshot.mimeType, "image/png");
  assert.equal(snapshot.bytes, 3);
  assert.equal(snapshot.data, Buffer.from([1, 2, 3]).toString("base64"));
});

test("snapshot sockets use the approved IP and verify the original TLS hostname", () => {
  const options = pinnedSnapshotRequestOptions(new URL("https://cdn.example.test:8443/image?signature=mock"), { address: "8.8.8.8", family: 4 });
  assert.equal(options.hostname, "8.8.8.8"); assert.equal(options.servername, "cdn.example.test");
  assert.equal(options.agent, false); assert.equal(options.port, "8443"); assert.equal(options.path, "/image?signature=mock");
  assert.equal((options.headers as { Host: string }).Host, "cdn.example.test:8443");
  assert.equal(options.checkServerIdentity?.("8.8.8.8", { subjectaltname: "DNS:cdn.example.test" } as DetailedPeerCertificate), undefined);
  assert.ok(options.checkServerIdentity?.("8.8.8.8", { subjectaltname: "DNS:attacker.test" } as DetailedPeerCertificate));
});

test("redirects pass separately approved IPs to the download transport", async () => {
  const seen: string[] = [];
  const provider = createProvider(async (input, _init, addresses) => {
    const url = new URL(input); seen.push(`${url.hostname}:${addresses?.[0]?.address}`);
    return seen.length === 1
      ? new Response(null, { status: 302, headers: { Location: "https://second.example.test/image" } })
      : new Response(new Uint8Array([1]), { headers: { "Content-Type": "image/jpeg" } });
  }, async (hostname) => [{ address: hostname === "second.example.test" ? "1.1.1.1" : "8.8.8.8", family: 4 }]);
  await provider.getCameraSnapshot("camera-1");
  assert.deepEqual(seen, ["cdn.example.test:8.8.8.8", "second.example.test:1.1.1.1"]);
});

test("a DNS response containing a private address is rejected before connection", async () => {
  let fetchCalls = 0;
  const provider = createProvider(async () => { fetchCalls++; return new Response(); }, async () => [{ address: "8.8.8.8", family: 4 }, { address: "127.0.0.1", family: 4 }]);
  await assert.rejects(provider.getCameraSnapshot("camera-1"), /public destination/); assert.equal(fetchCalls, 0);
});

test("snapshot deadline includes a DNS lookup that never resolves", async () => {
  let fetchCalls = 0;
  const provider = createProvider(async () => { fetchCalls++; return new Response(); }, () => new Promise(() => {}), 20);
  const started = Date.now();
  await assert.rejects(provider.getCameraSnapshot("camera-1"), (error: unknown) => error instanceof ADTError && error.code === "UPSTREAM_TIMEOUT");
  assert.ok(Date.now() - started < 1_000); assert.equal(fetchCalls, 0);
});

test("snapshot deadline cancels a stalled body stream", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
  const provider = createProvider(async () => new Response(body, { headers: { "Content-Type": "image/png" } }), undefined, 20);
  await assert.rejects(provider.getCameraSnapshot("camera-1"), (error: unknown) => error instanceof ADTError && error.code === "UPSTREAM_TIMEOUT");
  assert.equal(cancelled, true);
});

function createProvider(
  fetchImpl: (input: string | URL, init?: RequestInit, addresses?: Array<{ address: string; family: number }>) => Promise<Response>,
  lookupHost = async (_hostname: string) => [{ address: "8.8.8.8", family: 4 }],
  timeoutMs = 1_000,
): RealADTClient {
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
    setThermostatState: async () => undefined,
    setThermostatTargetHeatTemperature: async () => undefined,
    setThermostatTargetCoolTemperature: async () => undefined,
    getCameraSnapshotUrl: async () => "https://cdn.example.test/snapshot.jpg",
  };
  return new RealADTClient(
    config,
    api,
    timeoutMs,
    fetchImpl,
    lookupHost,
  );
}
