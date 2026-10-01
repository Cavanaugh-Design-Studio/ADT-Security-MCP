import { describeAction, targetIdForAction } from "./adt-client.js";
import type { AuditLog } from "./audit-log.js";
import { deriveDeviceAlerts } from "./device-alerts.js";
import { ConfirmationStore } from "./confirmation-store.js";
import { logUnexpectedError } from "./operational-log.js";
import { SecurityActionSchema, type AuditEntry, type Confirmation, type Dashboard, type Device, type DeviceAlert, type OperationResult, type SecurityAction, type SecurityProvider } from "./types.js";

export class SecurityService {
  private dashboardRead: Promise<Omit<Dashboard, "recentActivity">> | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    readonly provider: SecurityProvider,
    readonly audit: AuditLog,
    readonly confirmations = new ConfirmationStore(),
  ) {}

  async getDashboard(activityLimit = 20): Promise<Dashboard> {
    const [dashboard, recentActivity] = await Promise.all([
      this.getProviderDashboard(),
      this.audit.list(activityLimit),
    ]);
    return { ...dashboard, recentActivity };
  }

  async prepare(action: SecurityAction): Promise<Confirmation> {
    if (!this.provider.mutationsEnabled) {
      throw new ServiceError(
        "MUTATIONS_DISABLED",
        this.provider.mutationWarning ?? "Real-device mutations are disabled. Set ADT_ALLOW_MUTATIONS=true after validating read-only access.",
      );
    }
    const parsed = SecurityActionSchema.safeParse(action);
    if (!parsed.success) throw new ServiceError("INVALID_ACTION", parsed.error.issues[0]?.message ?? "Security action is invalid.");
    const dashboard = await this.getProviderDashboard();
    validateActionTarget(parsed.data, dashboard.devices);
    return this.confirmations.create(parsed.data, describeAction(parsed.data));
  }

  async commit(token: string, action: SecurityAction): Promise<OperationResult> {
    this.confirmations.consume(token, action);
    const operation = this.mutationQueue.catch(() => undefined).then(() => this.executeAndAudit(action));
    this.mutationQueue = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async executeAndAudit(action: SecurityAction): Promise<OperationResult> {
    const startedAt = Date.now();
    try {
      const result = await this.provider.execute(action);
      try {
        await this.audit.append({
          mode: this.provider.mode,
          actionType: action.type,
          targetId: targetIdForAction(action),
          summary: result.summary,
          outcome: result.status,
          durationMs: Date.now() - startedAt,
        });
        return { ...result, auditRecorded: true };
      } catch (auditError) {
        logUnexpectedError("audit_append_failed_after_action", auditError, {
          operationId: result.operationId,
          actionType: action.type,
        });
        return {
          ...result,
          auditRecorded: false,
          warning: [result.warning, "The local audit record could not be written. Do not retry the action solely because of this warning."].filter(Boolean).join(" "),
        };
      }
    } catch (error) {
      try {
        await this.audit.append({
          mode: this.provider.mode,
          actionType: action.type,
          targetId: targetIdForAction(action),
          summary: `${describeAction(action)} failed.`,
          outcome: "failed",
          durationMs: Date.now() - startedAt,
          errorCode: getErrorCode(error),
        });
      } catch (auditError) {
        logUnexpectedError("audit_append_failed_after_action_error", auditError, { actionType: action.type });
      }
      throw error;
    }
  }

  async getAlerts(limit: number): Promise<DeviceAlert[]> {
    const dashboard = await this.getProviderDashboard();
    return deriveDeviceAlerts(dashboard.devices, dashboard.refreshedAt, limit);
  }

  getHistory(limit: number): Promise<AuditEntry[]> {
    return this.audit.list(limit);
  }

  private getProviderDashboard(): Promise<Omit<Dashboard, "recentActivity">> {
    if (this.dashboardRead) return this.dashboardRead;
    const read = this.provider.getDashboard();
    this.dashboardRead = read;
    void read.finally(() => {
      if (this.dashboardRead === read) this.dashboardRead = undefined;
    }).catch(() => undefined);
    return read;
  }
}

export class ServiceError extends Error {
  constructor(readonly code: "MUTATIONS_DISABLED" | "INVALID_TARGET" | "INVALID_ACTION", message: string) {
    super(message);
    this.name = "ServiceError";
  }
}

function validateActionTarget(action: SecurityAction, devices: Device[]): void {
  const target = devices.find((device) => device.id === targetIdForAction(action));
  if (!target) throw new ServiceError("INVALID_TARGET", "The requested device was not found.");
  const validType =
    (action.type === "arm" || action.type === "disarm") ? target.type === "panel"
      : action.type === "lock" ? target.type === "lock"
        : action.type === "light" ? target.type === "light"
          : target.type === "thermostat";
  if (!validType) throw new ServiceError("INVALID_TARGET", "The target device type does not support this action.");

  const capability = action.type === "arm" ? "arm"
    : action.type === "disarm" ? "disarm"
      : action.type === "lock" ? (action.locked ? "lock" : "unlock")
        : action.type === "light" ? (action.isOn ? "on" : "off")
          : "mode";
  if (!target.capabilities.includes(capability)) {
    throw new ServiceError("INVALID_TARGET", `The target device does not advertise the ${capability} capability.`);
  }
  if (action.type === "light" && action.isOn && action.brightness !== undefined && !target.capabilities.includes("brightness")) {
    throw new ServiceError("INVALID_TARGET", "The target light does not advertise brightness control.");
  }
  if (action.type === "thermostat" && action.mode !== "off" && !target.capabilities.includes("temperature")) {
    throw new ServiceError("INVALID_TARGET", "The target thermostat does not advertise temperature control.");
  }
}

function getErrorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") return error.code;
  return "UNEXPECTED_ERROR";
}
