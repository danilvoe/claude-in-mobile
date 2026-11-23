/**
 * MCP tools for the Aurora Flutter/QEMU workflow.
 *
 * Tool results are JSON-serialisable and never contain VM Service/DDS URIs,
 * auth tokens or `root_password`. Domain failures are returned as
 * `{ ok: false, error: { code, message } }` so the model can react to
 * RUN_IN_PROGRESS, DEVICE_NOT_FOUND, AMBIGUOUS_DEVICE_MAPPING, etc.
 */

import { z } from "zod";
import type { ToolDefinition } from "@mcp-devices/plugin-api";

import { errorCode, FlutterError } from "./errors.js";
import { redactSecrets } from "./redact.js";
import { FlutterTestController } from "./test.js";

const projectPath = z
  .string()
  .min(1)
  .max(4096)
  .describe("Absolute path to the Flutter project (contains pubspec.yaml).");

const deviceId = z
  .string()
  .min(1)
  .max(256)
  .describe("audb device ID (for example 'emulator'). Passed explicitly to every audb call.");

const flutterPath = z
  .string()
  .min(1)
  .max(4096)
  .optional()
  .describe(
    "Optional absolute path to the Aurora Flutter binary. Defaults to FLUTTER_AURORA_BIN or flutter-aurora from PATH.",
  );

const testPath = z
  .string()
  .min(1)
  .max(4096)
  .describe("Test file inside the project's integration_test directory.");

function makeTool<S extends z.ZodTypeAny>(options: {
  name: string;
  description: string;
  schema: S;
  handler: (args: z.output<S>, controller: FlutterTestController) => Promise<unknown>;
}): (controller: FlutterTestController) => ToolDefinition {
  const inputSchema = z.toJSONSchema(options.schema, {
    target: "draft-2020-12",
  }) as Record<string, unknown>;

  return (controller) => ({
    name: options.name,
    description: options.description,
    inputSchema,
    async handler(rawArgs: unknown): Promise<unknown> {
      const parsed = options.schema.safeParse(rawArgs ?? {});
      if (!parsed.success) {
        const issues = parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
          .join("; ");
        throw new FlutterError(`Invalid arguments for ${options.name}: ${issues}`, "INVALID_ARGUMENT");
      }
      try {
        return await options.handler(parsed.data, controller);
      } catch (error) {
        return {
          ok: false,
          error: {
            code: errorCode(error),
            message: redactSecrets(error instanceof Error ? error.message : String(error)),
          },
        };
      }
    },
  });
}

const doctorTool = makeTool({
  name: "flutter_doctor",
  description:
    "Check the Aurora Flutter environment for QEMU: flutter-aurora path/realpath, version and Aurora channel, `flutter doctor`, `flutter devices --machine`, audb doctor/capabilities, project dev_dependencies and Aurora RPM spec, plus the audb↔Flutter device mapping. Never reads devices.toml or root_password; VM Service URIs are redacted.",
  schema: z.object({
    projectPath: projectPath.optional().describe("Optional Flutter project to inspect."),
    deviceId: deviceId.optional(),
    flutterPath,
  }),
  handler: async (args, controller) => {
    const report = await controller.doctor({
      projectPath: args.projectPath,
      deviceId: args.deviceId,
      flutterPath: args.flutterPath,
    });
    return report;
  },
});

const devicesTool = makeTool({
  name: "flutter_devices",
  description:
    "List Aurora Flutter devices from `flutter devices --machine`, list audb devices from `audb --json device list`, and map audb IDs to Flutter IDs (emulator.emulatorName ↔ Flutter id). Missing or ambiguous mappings are explicit errors. No devices.toml entry is required for the auto-discovered QEMU emulator.",
  schema: z.object({
    deviceId: deviceId.optional().describe("Optional audb device ID to map explicitly."),
    flutterPath,
  }),
  handler: async (args, controller) => {
    return controller.devices({
      deviceId: args.deviceId,
      flutterPath: args.flutterPath,
    });
  },
});

const testTool = makeTool({
  name: "flutter_test",
  description:
    "Run one debug Flutter integration test on an Aurora device via `flutter-aurora test`. Produces result.json (schema v1), JUnit, summary.txt, redacted Flutter logs, QMP screenshots (baseline + event + bounded periodic), journal and crash events. Returns the child Flutter exit code, runStatus/testStatus, reporter completeness and absolute artifact paths. One run per audb device; concurrent calls return RUN_IN_PROGRESS. Apps that declare runtime permissions can block on the system permission dialog after install (R6 limitation).",
  schema: z.object({
    projectPath,
    testPath,
    deviceId,
    runTimeoutMs: z
      .number()
      .int()
      .min(10_000)
      .max(4 * 60 * 60 * 1000)
      .default(600_000)
      .describe("External run deadline in milliseconds (independent of --timeout)."),
    testTimeout: z
      .number()
      .int()
      .min(1)
      .max(86_400)
      .optional()
      .describe("Optional per-test timeout in seconds passed to flutter test --timeout."),
    artifactsDir: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe(
        "Base directory for run artifacts. A private <dir>/runs/<run-id> directory is created. Defaults to <project>/.audb.",
      ),
    screenshotIntervalMs: z
      .number()
      .int()
      .min(0)
      .max(600_000)
      .default(5_000)
      .describe("Periodic screenshot interval in ms after the first testStart; 0 disables periodic capture."),
    permissionPolicy: z
      .enum(["fail", "allow_prompt"])
      .default("fail")
      .describe(
        "For apps that declare Sailjail permissions: fail (default) returns PERMISSIONS_REQUIRE_GRANT before launching; allow_prompt runs and requires an external answer to the system dialog.",
      ),
    flutterPath,
  }),
  handler: async (args, controller) => {
    return controller.run(
      {
        projectPath: args.projectPath,
        testPath: args.testPath,
        deviceId: args.deviceId,
        runTimeoutMs: args.runTimeoutMs,
        testTimeout: args.testTimeout,
        artifactsDir: args.artifactsDir,
        screenshotIntervalMs: args.screenshotIntervalMs,
        permissionPolicy: args.permissionPolicy,
      },
      { flutterPath: args.flutterPath },
    );
  },
});

const permissionsTool = makeTool({
  name: "flutter_permissions",
  description:
    "Read or change Sailjail permissions for an installed Aurora application through audb-agent. list returns declared/granted permissions and dialog state; grant/reset/revoke/prompt mutate the same state. The application must already be installed. flutter_test reinstall resets grants, so permission-declaring apps need an explicit pre-install/grant workflow or permissionPolicy='allow_prompt'.",
  schema: z.object({
    deviceId,
    applicationId: z
      .string()
      .min(1)
      .max(255)
      .describe("Sailjail application ID, usually the .desktop/RPM package ID (for example ru.example.app)."),
    action: z
      .enum(["list", "grant", "reset", "revoke", "prompt"])
      .describe("Permission operation to perform."),
    permissions: z
      .array(z.string().min(1).max(128))
      .max(256)
      .optional()
      .describe("Permission names for grant/revoke. Omit for list/reset/prompt."),
    allRequested: z
      .boolean()
      .default(false)
      .describe("For grant: grant every permission declared in the .desktop file."),
    disablePrompt: z
      .boolean()
      .default(true)
      .describe("For grant: disable the system dialog while granting (required when the dialog is enabled)."),
    promptEnabled: z
      .boolean()
      .optional()
      .describe("For prompt: true enables the dialog and clears grants; false disables it and preserves grants."),
  }),
  handler: async (args, controller) => {
    if (args.action === "list") {
      const state = await controller.permissionState(args.deviceId, args.applicationId);
      return { ok: true, action: "list", state };
    }
    if (args.action === "grant") {
      return {
        ok: true,
        action: "grant",
        ...(await controller.grantPermissions(args.deviceId, args.applicationId, {
          permissions: args.permissions,
          allRequested: args.allRequested,
          disablePrompt: args.disablePrompt,
        })),
      };
    }
    if (args.action === "reset") {
      return {
        ok: true,
        action: "reset",
        ...(await controller.resetPermissions(args.deviceId, args.applicationId)),
      };
    }
    if (args.action === "revoke") {
      return {
        ok: true,
        action: "revoke",
        ...(await controller.revokePermissions(
          args.deviceId,
          args.applicationId,
          args.permissions ?? [],
        )),
      };
    }
    if (typeof args.promptEnabled !== "boolean") {
      throw new FlutterError(
        "promptEnabled is required for action='prompt'.",
        "INVALID_ARGUMENT",
      );
    }
    return {
      ok: true,
      action: "prompt",
      ...(await controller.setPermissionPrompt(
        args.deviceId,
        args.applicationId,
        args.promptEnabled,
      )),
    };
  },
});

/** Build all Flutter tools bound to one controller. */
export function buildFlutterTools(controller: FlutterTestController): ToolDefinition[] {
  return [
    doctorTool(controller),
    devicesTool(controller),
    testTool(controller),
    permissionsTool(controller),
  ];
}
