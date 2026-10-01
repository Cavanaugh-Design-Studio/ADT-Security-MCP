import { isCriticalDevice, type Device, type DeviceAlert } from "./types.js";

export function deriveDeviceAlerts(devices: Device[], timestamp: string, limit: number): DeviceAlert[] {
  return devices.flatMap((device): DeviceAlert[] => {
    const critical = isCriticalDevice(device);
    const warning = ["unknown", "offline", "triggered"].includes(device.status) || device.battery === "low";
    if (!critical && !warning) return [];
    const message = device.battery === "critical" ? `${device.name} reports a critical battery condition.`
      : device.battery === "low" ? `${device.name} reports a low battery.`
        : device.status === "offline" ? `${device.name} is offline or unreachable.`
          : device.status === "unknown" ? `${device.name} state is unknown.` : `${device.name} is triggered.`;
    return [{ id: `${device.id}:${timestamp}`, timestamp, severity: critical ? "critical" : "warning", message, deviceId: device.id, deviceName: device.name }];
  }).sort((left, right) => Number(right.severity === "critical") - Number(left.severity === "critical")).slice(0, limit);
}
