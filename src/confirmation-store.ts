import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Confirmation, SecurityAction } from "./types.js";

interface StoredConfirmation {
  action: SecurityAction;
  digest: Buffer;
  expiresAtMs: number;
  summary: string;
}

export class ConfirmationError extends Error {
  constructor(
    readonly code: "CONFIRMATION_INVALID" | "CONFIRMATION_EXPIRED" | "CONFIRMATION_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "ConfirmationError";
  }
}

export class ConfirmationStore {
  private readonly entries = new Map<string, StoredConfirmation>();

  constructor(
    private readonly ttlMs = 120_000,
    private readonly maxEntries = 100,
    private readonly now: () => number = Date.now,
  ) {}

  create(action: SecurityAction, summary: string): Confirmation {
    this.prune();
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest) this.entries.delete(oldest);
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAtMs = this.now() + this.ttlMs;
    this.entries.set(token, {
      action,
      digest: digestAction(action),
      expiresAtMs,
      summary,
    });

    return {
      token,
      summary,
      expiresAt: new Date(expiresAtMs).toISOString(),
      action,
    };
  }

  consume(token: string, expectedAction: SecurityAction): StoredConfirmation {
    const entry = this.entries.get(token);
    this.entries.delete(token);

    if (!entry) {
      throw new ConfirmationError("CONFIRMATION_INVALID", "Confirmation token is invalid or has already been used.");
    }
    if (entry.expiresAtMs <= this.now()) {
      throw new ConfirmationError("CONFIRMATION_EXPIRED", "Confirmation token has expired. Prepare the action again.");
    }

    const expectedDigest = digestAction(expectedAction);
    if (entry.digest.length !== expectedDigest.length || !timingSafeEqual(entry.digest, expectedDigest)) {
      throw new ConfirmationError("CONFIRMATION_MISMATCH", "Confirmation token does not match this action.");
    }
    return entry;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, entry] of this.entries) {
      if (entry.expiresAtMs <= now) this.entries.delete(token);
    }
  }
}

function digestAction(action: SecurityAction): Buffer {
  return createHash("sha256").update(JSON.stringify(action)).digest();
}
