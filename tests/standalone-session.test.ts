import assert from "node:assert/strict";
import test from "node:test";
import { StandaloneSessionManager } from "../src/standalone-session.js";

function storage(initial: string | null) {
  let value = initial;
  return { getItem: () => value, setItem: (_key: string, token: string) => { value = token; }, removeItem: () => { value = null; } };
}

test("a fresh bootstrap replaces an expired stored session and exchanges only once", async () => {
  const store = storage("expired"); let exchanges = 0;
  const manager = new StandaloneSessionManager("new-bootstrap", store, async function (this: unknown, _url, init) {
    // Browser fetch is a WebIDL method and rejects an arbitrary receiver.
    assert.equal(this, globalThis);
    exchanges++; assert.equal(JSON.parse(init?.body as string).bootstrapToken, "new-bootstrap");
    return Response.json({ token: "fresh-session" });
  });
  assert.deepEqual(await Promise.all([manager.getToken(), manager.getToken()]), ["fresh-session", "fresh-session"]);
  assert.equal(exchanges, 1); assert.equal(store.getItem(), "fresh-session");
});

test("expired sessions are evicted without automatically retrying actions", async () => {
  const store = storage("expired"); let exchanges = 0;
  const manager = new StandaloneSessionManager(undefined, store, async () => { exchanges++; throw new Error("unexpected exchange"); });
  assert.equal(await manager.getToken(), "expired"); manager.invalidate("expired");
  assert.equal(store.getItem(), null); await assert.rejects(manager.getToken(), /Request a new link/); assert.equal(exchanges, 0);
});

test("a failed exchange does not poison future session lookup", async () => {
  const store = storage("old"); const manager = new StandaloneSessionManager("invalid-bootstrap", store, async () => new Response(null, { status: 401 }));
  await assert.rejects(manager.getToken(), /invalid, expired/); assert.equal(store.getItem(), null);
  store.setItem("adt-standalone-session", "recovered"); assert.equal(await manager.getToken(), "recovered");
});

test("fresh links recover in the same tab without using its previous token", async () => {
  const store = storage("old-session");
  const manager = new StandaloneSessionManager(undefined, store, async () => Response.json({ token: "new-session" }));
  assert.equal(await manager.getToken(), "old-session");
  manager.useBootstrap("fresh-link");
  assert.equal(await manager.getToken(), "new-session");
  manager.invalidate("old-session");
  assert.equal(await manager.getToken(), "new-session");
});
