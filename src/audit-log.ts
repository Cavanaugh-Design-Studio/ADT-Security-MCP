import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { AuditEntrySchema, type AuditEntry } from "./types.js";

export interface AuditLog {
  append(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<AuditEntry>;
  list(limit: number): Promise<AuditEntry[]>;
}

export class JsonlAuditLog implements AuditLog {
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly filePath: string,
    private readonly maxBytes = 5 * 1024 * 1024,
  ) {}

  async append(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<AuditEntry> {
    const complete: AuditEntry = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      ...entry,
    };

    const write = this.writeQueue.catch(() => undefined).then(async () => {
      await mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
      await this.rotateIfNeeded();
      await appendFile(this.filePath, `${JSON.stringify(complete)}\n`, { encoding: "utf8", mode: 0o600 });
    });
    // Keep the ordering barrier usable after a failed append. The caller still
    // receives the error through `write`, without poisoning future reads.
    this.writeQueue = write.catch(() => undefined);
    await write;
    return complete;
  }

  async list(limit: number): Promise<AuditEntry[]> {
    await this.writeQueue;
    try {
      const content = await readFile(this.filePath, "utf8");
      return content
        .trim()
        .split("\n")
        .filter(Boolean)
        .slice(-limit)
        .reverse()
        .flatMap((line) => {
          try {
            const parsed = AuditEntrySchema.safeParse(JSON.parse(line));
            return parsed.success ? [parsed.data] : [];
          } catch {
            return [];
          }
        });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
  }

  private async rotateIfNeeded(): Promise<void> {
    try {
      const current = await stat(this.filePath);
      if (current.size < this.maxBytes) return;
      await rm(`${this.filePath}.1`, { force: true });
      await rename(this.filePath, `${this.filePath}.1`);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    }
  }
}

export class MemoryAuditLog implements AuditLog {
  readonly entries: AuditEntry[] = [];

  async append(entry: Omit<AuditEntry, "id" | "timestamp">): Promise<AuditEntry> {
    const complete = { id: randomUUID(), timestamp: new Date().toISOString(), ...entry };
    this.entries.push(complete);
    return complete;
  }

  async list(limit: number): Promise<AuditEntry[]> {
    return this.entries.slice(-limit).reverse();
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
