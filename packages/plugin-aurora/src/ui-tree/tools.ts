/**
 * `aurora_ui_setup` — explicit, agent-controlled setup for the Qt/QML UI tree.
 *
 * Flutter debug apps need no setup (the VM Service is already available). For
 * QML apps this tool enables the qtium bridge and refreshes sailjail
 * permissions; it only restarts the app when the caller explicitly asks for it,
 * because restarting discards the app's state.
 */

import { z } from "zod";
import type { ToolDefinition } from "@mcp-devices/plugin-api";

import type { AuroraUiTreeProvider } from "./provider.js";
import { errorCode } from "../flutter/errors.js";
import { redactSecrets } from "../flutter/redact.js";

export function buildAuroraUiTools(provider: AuroraUiTreeProvider): ToolDefinition[] {
  const schema = z.object({
    deviceId: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe("Optional audb device ID. Defaults to the active Aurora device."),
    packageName: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe(
        "Application package to configure. Defaults to the last app launched through MCP, AURORA_UI_APP, or the only running app.",
      ),
    restartApp: z
      .boolean()
      .default(false)
      .describe(
        "Restart the application so the qtium LD_PRELOAD hook is loaded. This resets the app state; only set it when the caller accepts that.",
      ),
    enableAutoTest: z
      .boolean()
      .default(true)
      .describe(
        "Enable Aurora developer-mode UI autotesting (starts qtium-bridge) when it is not already running.",
      ),
  });

  return [
    {
      name: "aurora_ui_setup",
      description:
        "Prepare Aurora UI inspection. Flutter debug apps need nothing; Qt/QML apps need the qtium hook. Enables developer-mode UI autotesting, refreshes sailjail permissions, and optionally restarts the app when restartApp=true (the app state is reset). Idempotent.",
      inputSchema: z.toJSONSchema(schema, { target: "draft-2020-12" }) as Record<string, unknown>,
      async handler(rawArgs: unknown): Promise<unknown> {
        const parsed = schema.safeParse(rawArgs ?? {});
        if (!parsed.success) {
          return {
            ok: false,
            error: {
              code: "INVALID_ARGUMENT",
              message: parsed.error.issues
                .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
                .join("; "),
            },
          };
        }

        try {
          provider.selectDevice(parsed.data.deviceId);
          const result = await provider.setup({
            packageName: parsed.data.packageName,
            restartApp: parsed.data.restartApp,
            enableAutoTest: parsed.data.enableAutoTest,
          });
          return result;
        } catch (error) {
          return {
            ok: false,
            error: {
              code: errorCode(error, "AURORA_UI_SETUP_FAILED"),
              message: redactSecrets(error instanceof Error ? error.message : String(error)),
            },
          };
        }
      },
    },
  ];
}
