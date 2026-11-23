import { readFileSync, statSync } from "fs";
import { defineTool, z } from "../define-tool.js";
import { platformEnum, deviceIdField } from "../common-schema.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult, errorResult } from "../../utils/tool-result.js";
import { dispatchByPlatform } from "../helpers/dispatch.js";
import { hasLocation } from "../../adapters/platform-adapter.js";
import type {
  TrackControlAction,
  TrackOptions,
  TrackPoint,
} from "../../adapters/platform-adapter.js";
import { ValidationError } from "../../errors.js";
import {
  validateLatitude,
  validateLongitude,
  validateNumber,
} from "./helpers.js";

const MAX_TRACK_FILE_BYTES = 5 * 1024 * 1024;
const DEFAULT_INTERVAL_MS = 2000;

const rawPointSchema = z.object({
  latitude: z.unknown(),
  longitude: z.unknown(),
  altitude: z.unknown().optional(),
  intervalMs: z.unknown().optional(),
  interval: z.unknown().optional(),
});

type RawPoint = z.output<typeof rawPointSchema>;

function readFilePositions(file: string): unknown[] {
  let size: number;
  try {
    const stats = statSync(file);
    if (!stats.isFile()) {
      throw new ValidationError(`Track file is not a regular file: ${file}`);
    }
    size = stats.size;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(`Unable to read track file: ${file}`);
  }
  if (size > MAX_TRACK_FILE_BYTES) {
    throw new ValidationError(
      `Track file exceeds ${MAX_TRACK_FILE_BYTES} bytes: ${file}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new ValidationError(`Track file is not valid JSON: ${file}`);
  }

  const positions =
    parsed !== null && typeof parsed === "object" && "positions" in parsed
      ? (parsed as { positions?: unknown }).positions
      : parsed;
  if (!Array.isArray(positions)) {
    throw new ValidationError(
      "Track JSON must be an array of points or an object with a 'positions' array.",
    );
  }
  return positions;
}

function normalizePoints(rawPoints: unknown[]): TrackPoint[] {
  if (rawPoints.length === 0) {
    throw new ValidationError("Track must contain at least one point.");
  }

  return rawPoints.map((raw, index) => {
    if (raw === null || typeof raw !== "object") {
      throw new ValidationError(`positions[${index}] must be an object.`);
    }
    const point = raw as Partial<RawPoint>;
    const latitude = validateNumber(point.latitude, `positions[${index}].latitude`);
    const longitude = validateNumber(point.longitude, `positions[${index}].longitude`);
    validateLatitude(latitude);
    validateLongitude(longitude);

    const altitude =
      point.altitude === undefined ? 0 : validateNumber(point.altitude, `positions[${index}].altitude`);
    if (!Number.isFinite(altitude)) {
      throw new ValidationError(`positions[${index}].altitude must be finite.`);
    }

    const rawInterval = point.intervalMs ?? point.interval;
    const intervalMs =
      rawInterval === undefined
        ? DEFAULT_INTERVAL_MS
        : validateNumber(rawInterval, `positions[${index}].intervalMs`);
    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
      throw new ValidationError(
        `positions[${index}].intervalMs must be a non-negative number.`,
      );
    }

    return { latitude, longitude, altitude, intervalMs };
  });
}

function trackOptions(args: {
  loop?: boolean;
  speed?: unknown;
  defaultInterval?: boolean;
}): TrackOptions {
  const options: TrackOptions = {};
  if (args.loop !== undefined) options.loop = args.loop;
  if (args.defaultInterval !== undefined) options.defaultInterval = args.defaultInterval;
  if (args.speed !== undefined) {
    const speed = validateNumber(args.speed, "speed");
    if (!Number.isInteger(speed) || speed < 1 || speed > 5) {
      throw new ValidationError(`speed must be an integer between 1 and 5, got: ${speed}`);
    }
    options.speed = speed;
  }
  return options;
}

export const sensorTrackTool = defineTool({
  name: "sensor_track",
  description:
    "Load and control an emulated GPS track (route) on the Aurora emulator. Use 'operation' for load/start/pause/resume/stop/goto: load accepts positions[] or a host JSON file. Emulators only; requires audb >= 0.4.2 and @mcp-devices/plugin-aurora with location support.",
  schema: z.object({
    operation: z
      .enum(["load", "start", "pause", "resume", "stop", "goto"])
      .describe("Track operation"),
    positions: z
      .array(rawPointSchema)
      .optional()
      .describe(
        "Track points for 'load': latitude, longitude, optional altitude and intervalMs (default 2000).",
      ),
    file: z
      .string()
      .optional()
      .describe(
        "Host path to a JSON track for 'load'. Accepts an array of points or {\"positions\": [...]}.",
      ),
    index: z.unknown().optional().describe("Point index for the 'goto' action"),
    loop: z.boolean().optional().describe("Loop track playback"),
    speed: z.unknown().optional().describe("Playback speed multiplier 1–5"),
    defaultInterval: z
      .boolean()
      .optional()
      .describe("true — use per-point intervalMs; false — fixed 2 s per point"),
    platform: platformEnum,
    deviceId: deviceIdField,
  }),
  handler: async (args, ctx) => {
    const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);

    return dispatchByPlatform(platform, {
      aurora: async () => {
        const adapter = ctx.deviceManager.getAdapter("aurora", deviceId);
        if (!hasLocation(adapter)) {
          return errorResult(
            "Aurora track emulation requires a newer @mcp-devices/plugin-aurora " +
              "with the LocationAdapter capability. Update the plugin and restart the MCP server.",
          );
        }

        const options = trackOptions(args);
        const hasPositions = args.positions !== undefined;
        const hasFile = args.file !== undefined;

        try {
          if (args.operation === "load") {
            if (hasPositions === hasFile) {
              throw new ValidationError(
                "The load action requires exactly one of 'positions' or 'file'.",
              );
            }
            const points = normalizePoints(
              hasFile ? readFilePositions(args.file as string) : (args.positions as RawPoint[]),
            );
            const message = await adapter.loadTrack(points, options, deviceId);
            return textResult(message);
          }

          if (hasPositions || hasFile) {
            throw new ValidationError(
              `positions/file are only valid for the load action, not '${args.operation}'.`,
            );
          }

          let index: number | undefined;
          if (args.index !== undefined) {
            const parsedIndex = validateNumber(args.index, "index");
            if (!Number.isInteger(parsedIndex) || parsedIndex < 0) {
              throw new ValidationError("index must be a non-negative integer.");
            }
            index = parsedIndex;
          }
          if (args.operation === "goto" && index === undefined) {
            throw new ValidationError("The goto action requires 'index'.");
          }
          if (args.operation !== "goto" && index !== undefined) {
            throw new ValidationError("'index' is only valid for the goto action.");
          }

          const message = await adapter.controlTrack(
            args.operation as TrackControlAction,
            { ...options, index },
            deviceId,
          );
          return textResult(message);
        } catch (error) {
          if (error instanceof ValidationError) throw error;
          const message = error instanceof Error ? error.message : String(error);
          return errorResult(`Failed to load/control GPS track on Aurora emulator: ${message}`);
        }
      },
      unsupported: (p) =>
        textResult(
          `sensor_track is not supported on platform: ${p}. Supported: aurora (emulator).`,
        ),
    });
  },
});
