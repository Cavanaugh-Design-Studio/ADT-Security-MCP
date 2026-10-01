import * as z from "zod/v4";

export const DeviceTypeSchema = z.enum([
  "panel",
  "sensor",
  "lock",
  "light",
  "thermostat",
  "camera",
]);

export const DeviceStatusSchema = z.enum([
  "online",
  "offline",
  "unknown",
  "armed",
  "disarmed",
  "locked",
  "unlocked",
  "on",
  "off",
  "triggered",
]);

export const DeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: DeviceTypeSchema,
  status: DeviceStatusSchema,
  lastUpdated: z.string(),
  capabilities: z.array(z.string()),
  armMode: z.enum(["stay", "away", "night"]).optional(),
  triggered: z.boolean().optional(),
  sensorType: z.enum(["contact", "motion", "smoke", "carbon-monoxide", "heat", "water", "glass-break", "other"]).optional(),
  battery: z.enum(["normal", "low", "critical", "unknown"]).optional(),
  brightness: z.number().int().min(0).max(100).optional(),
  isDimmer: z.boolean().optional(),
  currentTemp: z.number().optional(),
  heatTarget: z.number().optional(),
  coolTarget: z.number().optional(),
  thermostatMode: z.enum(["off", "heat", "cool", "auto", "unknown"]).optional(),
  humidity: z.number().min(0).max(100).optional(),
  canTakeSnapshot: z.boolean().optional(),
});

export const SystemStatusSchema = z.object({
  mode: z.enum(["demo", "real"]),
  armed: z.boolean().nullable(),
  armStatus: z.enum(["armed", "disarmed", "mixed", "unknown"]),
  armMode: z.enum(["stay", "away", "night"]).optional(),
  health: z.enum(["healthy", "warning", "critical"]),
  connectedDevices: z.number().int().nonnegative(),
  totalDevices: z.number().int().nonnegative(),
  mutationsEnabled: z.boolean(),
  mutationWarning: z.string().optional(),
});

export const AuditEntrySchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  mode: z.enum(["demo", "real"]),
  actionType: z.string(),
  targetId: z.string(),
  summary: z.string(),
  outcome: z.enum(["completed", "submitted", "uncertain", "failed", "denied"]),
  durationMs: z.number().int().nonnegative(),
  errorCode: z.string().optional(),
});

export const DashboardSchema = z.object({
  system: SystemStatusSchema,
  devices: z.array(DeviceSchema),
  recentActivity: z.array(AuditEntrySchema),
  refreshedAt: z.string(),
});

const StableIdSchema = z.string().trim().min(1).max(200);
const FahrenheitSchema = z.number().min(45).max(95);
const AutoThermostatActionSchema = z.object({
  type: z.literal("thermostat"),
  thermostatId: StableIdSchema,
  mode: z.literal("auto"),
  heatTarget: FahrenheitSchema,
  coolTarget: FahrenheitSchema,
}).refine((action) => action.heatTarget < action.coolTarget, {
  message: "Auto heat target must be lower than the cool target.",
  path: ["coolTarget"],
});

export const SecurityActionSchema = z.union([
  z.object({
    type: z.literal("arm"),
    panelId: StableIdSchema,
    mode: z.enum(["stay", "away"]),
  }),
  z.object({
    type: z.literal("disarm"),
    panelId: StableIdSchema,
  }),
  z.object({
    type: z.literal("lock"),
    lockId: StableIdSchema,
    locked: z.boolean(),
  }),
  z.object({
    type: z.literal("light"),
    lightId: StableIdSchema,
    isOn: z.boolean(),
    brightness: z.number().int().min(1).max(100).optional(),
  }),
  z.object({
    type: z.literal("thermostat"),
    thermostatId: StableIdSchema,
    mode: z.literal("off"),
  }),
  z.object({
    type: z.literal("thermostat"),
    thermostatId: StableIdSchema,
    mode: z.enum(["heat", "cool"]),
    targetTemp: FahrenheitSchema,
  }),
  AutoThermostatActionSchema,
]);

export const DeviceAlertSchema = z.object({
  id: z.string(),
  timestamp: z.string(),
  severity: z.enum(["warning", "critical"]),
  message: z.string(),
  deviceId: z.string(),
  deviceName: z.string(),
});

export const AlertsResponseSchema = z.object({
  alerts: z.array(DeviceAlertSchema),
  refreshedAt: z.string(),
});

export const HistoryResponseSchema = z.object({
  events: z.array(AuditEntrySchema),
});

export const ConfirmationSchema = z.object({
  token: z.string(),
  summary: z.string(),
  expiresAt: z.string(),
  action: SecurityActionSchema,
});

export const OperationResultSchema = z.object({
  operationId: z.string(),
  status: z.enum(["completed", "submitted", "uncertain"]),
  summary: z.string(),
  verifiedAt: z.string().optional(),
  auditRecorded: z.boolean().optional(),
  warning: z.string().optional(),
});

export type Device = z.infer<typeof DeviceSchema>;
export type Dashboard = z.infer<typeof DashboardSchema>;
export type SecurityAction = z.infer<typeof SecurityActionSchema>;
export type Confirmation = z.infer<typeof ConfirmationSchema>;
export type OperationResult = z.infer<typeof OperationResultSchema>;
export type AuditEntry = z.infer<typeof AuditEntrySchema>;
export type DeviceAlert = z.infer<typeof DeviceAlertSchema>;

export function isCriticalDevice(device: Device): boolean {
  return device.battery === "critical"
    || (device.type === "sensor" && Boolean(device.triggered) && ["smoke", "carbon-monoxide"].includes(device.sensorType ?? ""));
}

export interface CameraSnapshot {
  cameraId: string;
  mimeType: string;
  data: string;
  bytes: number;
  capturedAt: string;
}

export interface SecurityProvider {
  readonly mode: "demo" | "real";
  readonly mutationsEnabled: boolean;
  readonly mutationWarning?: string | undefined;
  getDashboard(): Promise<Omit<Dashboard, "recentActivity">>;
  execute(action: SecurityAction): Promise<OperationResult>;
  getCameraSnapshot(cameraId: string): Promise<CameraSnapshot>;
}
