/**
 * Mapping between audb device IDs and Flutter device IDs.
 *
 * A QEMU emulator is auto-discovered by Flutter as `AuroraOS-5.2.0.180`; audb
 * exposes the same value in `emulator.emulatorName`. No `devices.toml` entry and
 * no `root_password` are required. Ambiguous or missing matches are hard errors.
 */

import { AudbCli } from "./audb.js";
import { FlutterError } from "./errors.js";
import { FlutterCli } from "./flutter-cli.js";
import type {
  AudbDeviceRecord,
  DeviceMapping,
  DeviceMappingSummary,
  DevicesReport,
  FlutterDevice,
  MappingMethod,
} from "./types.js";

export interface DeviceResolverOptions {
  flutter: FlutterCli;
  audb: AudbCli;
}

function normalize(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

function auroraDevices(devices: FlutterDevice[]): FlutterDevice[] {
  return devices.filter((device) => {
    const platform = normalize(device.targetPlatform);
    return platform.startsWith("aurora");
  });
}

interface Candidate {
  device: FlutterDevice;
  method: MappingMethod;
}

function candidatesFor(
  audbDevice: AudbDeviceRecord,
  flutterDevices: FlutterDevice[],
): Candidate[] {
  const candidates: Candidate[] = [];
  const seen = new Set<string>();

  const addAll = (devices: FlutterDevice[], method: MappingMethod): void => {
    for (const device of devices) {
      if (seen.has(device.id)) continue;
      seen.add(device.id);
      candidates.push({ device, method });
    }
  };

  const emulatorName = audbDevice.emulator?.emulatorName;
  if (emulatorName) {
    addAll(flutterDevices.filter((device) => device.id === emulatorName), "emulatorName");
  }

  addAll(flutterDevices.filter((device) => device.id === audbDevice.id), "id");
  addAll(
    flutterDevices.filter((device) => normalize(device.name) === normalize(audbDevice.name)),
    "name",
  );
  addAll(
    flutterDevices.filter((device) => normalize(device.id) === normalize(audbDevice.host)),
    "host",
  );

  return candidates;
}

export class DeviceResolver {
  constructor(
    private readonly flutter: FlutterCli,
    private readonly audb: AudbCli,
  ) {}

  async listFlutterDevices(): Promise<FlutterDevice[]> {
    return this.flutter.devicesMachine();
  }

  async listAudbDevices(): Promise<AudbDeviceRecord[]> {
    return this.audb.listDevices();
  }

  /** Resolve one audb device ID to exactly one Aurora Flutter device. */
  async resolve(
    deviceId: string,
    options: { flutterDevices?: FlutterDevice[]; audbDevices?: AudbDeviceRecord[] } = {},
  ): Promise<DeviceMapping> {
    const audbDevices = options.audbDevices ?? (await this.listAudbDevices());
    const flutterDevices = options.flutterDevices ?? (await this.listFlutterDevices());

    const duplicates = audbDevices.filter((device) => device.id === deviceId);
    if (duplicates.length > 1) {
      throw new FlutterError(
        `audb registry contains ${duplicates.length} devices with id '${deviceId}'.`,
        "AMBIGUOUS_DEVICE_MAPPING",
      );
    }

    const audbDevice = audbDevices.find((device) => device.id === deviceId);
    if (!audbDevice) {
      throw new FlutterError(
        `audb device '${deviceId}' is not registered. Known: ${audbDevices
          .map((device) => device.id)
          .join(", ") || "(none)"}.`,
        "DEVICE_NOT_FOUND",
      );
    }

    const aurora = auroraDevices(flutterDevices);
    if (aurora.length === 0) {
      throw new FlutterError(
        "No Aurora Flutter devices found. Start the emulator and check `flutter-aurora devices --machine`.",
        "FLUTTER_DEVICE_NOT_FOUND",
      );
    }

    const candidates = candidatesFor(audbDevice, aurora);
    if (candidates.length === 0) {
      throw new FlutterError(
        `No Flutter device matches audb device '${deviceId}' (${audbDevice.emulator?.emulatorName ?? audbDevice.name}).`,
        "FLUTTER_DEVICE_NOT_FOUND",
      );
    }
    if (candidates.length > 1) {
      throw new FlutterError(
        `Ambiguous Flutter mapping for audb device '${deviceId}': ${candidates
          .map((candidate) => `${candidate.device.id} (${candidate.method})`)
          .join(", ")}.`,
        "AMBIGUOUS_DEVICE_MAPPING",
      );
    }

    const candidate = candidates[0]!;
    return {
      audbDeviceId: deviceId,
      flutterDeviceId: candidate.device.id,
      method: candidate.method,
      audbDevice,
      flutterDevice: candidate.device,
    };
  }

  /**
   * List all devices and their mappings. If `deviceId` is supplied, a missing or
   * ambiguous mapping is an explicit error. Otherwise unmatched devices are
   * reported individually and `ok` is false when nothing maps.
   */
  async list(options: { deviceId?: string } = {}): Promise<DevicesReport> {
    const audbDevices = await this.listAudbDevices();
    const allFlutterDevices = await this.listFlutterDevices();
    const flutterDevices = auroraDevices(allFlutterDevices);
    const warnings: string[] = [];
    const unmatched: Array<{ audbDeviceId: string; reason: string }> = [];
    const mappings: DeviceMappingSummary[] = [];

    if (flutterDevices.length === 0) {
      throw new FlutterError(
        "No Aurora Flutter devices found. Start the emulator and check `flutter-aurora devices --machine`.",
        "FLUTTER_DEVICE_NOT_FOUND",
      );
    }

    const ids = new Set<string>();
    for (const device of audbDevices) {
      if (ids.has(device.id)) {
        throw new FlutterError(
          `audb registry contains duplicate device id '${device.id}'.`,
          "AMBIGUOUS_DEVICE_MAPPING",
        );
      }
      ids.add(device.id);
    }

    const selected = options.deviceId
      ? audbDevices.filter((device) => device.id === options.deviceId)
      : audbDevices;

    if (options.deviceId && selected.length === 0) {
      throw new FlutterError(
        `audb device '${options.deviceId}' is not registered.`,
        "DEVICE_NOT_FOUND",
      );
    }

    for (const audbDevice of selected) {
      const candidates = candidatesFor(audbDevice, flutterDevices);
      if (candidates.length === 0) {
        unmatched.push({
          audbDeviceId: audbDevice.id,
          reason: "No Flutter device matches this audb record.",
        });
        continue;
      }
      if (candidates.length > 1) {
        unmatched.push({
          audbDeviceId: audbDevice.id,
          reason: `Ambiguous mapping: ${candidates
            .map((candidate) => candidate.device.id)
            .join(", ")}.`,
        });
        continue;
      }
      const candidate = candidates[0]!;
      mappings.push({
        audbDeviceId: audbDevice.id,
        flutterDeviceId: candidate.device.id,
        method: candidate.method,
      });
    }

    if (options.deviceId) {
      if (unmatched.length > 0) {
        const reason = unmatched[0]!.reason;
        throw new FlutterError(
          reason,
          reason.startsWith("Ambiguous")
            ? "AMBIGUOUS_DEVICE_MAPPING"
            : "FLUTTER_DEVICE_NOT_FOUND",
        );
      }
      if (mappings.length === 0) {
        throw new FlutterError(
          `No Flutter device matches audb device '${options.deviceId}'.`,
          "FLUTTER_DEVICE_NOT_FOUND",
        );
      }
      if (mappings.length > 1) {
        throw new FlutterError(
          `Ambiguous Flutter mapping for audb device '${options.deviceId}'.`,
          "AMBIGUOUS_DEVICE_MAPPING",
        );
      }
    } else if (mappings.length === 0) {
      throw new FlutterError(
        "No audb device maps to an Aurora Flutter device.",
        "FLUTTER_DEVICE_NOT_FOUND",
      );
    }

    if (allFlutterDevices.length > flutterDevices.length) {
      warnings.push(
        `${allFlutterDevices.length - flutterDevices.length} non-Aurora Flutter device(s) ignored.`,
      );
    }

    return {
      ok: mappings.length > 0,
      audbDevices,
      flutterDevices: allFlutterDevices,
      mappings,
      unmatched,
      warnings,
    };
  }
}
