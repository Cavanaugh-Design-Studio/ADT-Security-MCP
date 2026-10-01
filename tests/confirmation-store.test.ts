import assert from "node:assert/strict";
import test from "node:test";
import { ConfirmationError, ConfirmationStore } from "../src/confirmation-store.js";

const arm = { type: "arm", panelId: "panel-1", mode: "stay" } as const;

test("confirmation tokens are scoped to the exact action and are one-use", () => {
  const store = new ConfirmationStore();
  const confirmation = store.create(arm, "Arm panel");

  assert.throws(
    () => store.consume(confirmation.token, { ...arm, mode: "away" }),
    (error: unknown) => error instanceof ConfirmationError && error.code === "CONFIRMATION_MISMATCH",
  );
  assert.throws(
    () => store.consume(confirmation.token, arm),
    (error: unknown) => error instanceof ConfirmationError && error.code === "CONFIRMATION_INVALID",
  );
});

test("confirmation tokens expire", () => {
  let now = 1_000;
  const store = new ConfirmationStore(50, 100, () => now);
  const confirmation = store.create(arm, "Arm panel");
  now += 50;

  assert.throws(
    () => store.consume(confirmation.token, arm),
    (error: unknown) => error instanceof ConfirmationError && error.code === "CONFIRMATION_EXPIRED",
  );
});
