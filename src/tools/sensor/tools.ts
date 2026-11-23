import type { ToolDefinition } from "../registry.js";
import { sensorLocationTool } from "./location.js";
import { sensorTrackTool } from "./track.js";
import { sensorBatteryTool } from "./battery.js";
import { sensorNotificationsTool } from "./notifications.js";
import { sensorThermalTool } from "./thermal.js";

export const sensorTools: ToolDefinition[] = [
  sensorLocationTool,
  sensorTrackTool,
  sensorBatteryTool,
  sensorNotificationsTool,
  sensorThermalTool,
];
