import { formatCrashEvents, formatCrashes } from "../../perf/formatter.js";
import { truncateOutput } from "../../utils/truncate.js";
import { defineTool, z } from "../define-tool.js";
import { parseCommonArgs } from "../../utils/parse-common-args.js";
import { textResult, errorResult } from "../../utils/tool-result.js";
import { hasCrashLogs } from "../../adapters/platform-adapter.js";
import { collectSnapshot, deviceIdField, platformEnum } from "./common.js";

export const performanceCrashes = defineTool({
  name: "performance_crashes",
  description:
    "Query recent crashes, ANRs, and native crashes from device logs. " +
    "Android/Desktop read logcat/app state; Aurora reads the OS journal via `audb crash list`.",
  schema: z.object({
    platform: platformEnum,
    packageName: z
      .string()
      .optional()
      .describe(
        "App package name. Android: auto-detected from the foreground app if omitted. " +
          "Aurora: optional filter for `audb crash list <package>`.",
      ),
    since: z
      .string()
      .optional()
      .describe(
        "Aurora only: crash search window for `audb crash list --since` — e.g. 'today', " +
          "'yesterday', '1 hour ago', '@<unix-seconds>', or '2026-11-24 09:00:00'. " +
          "Defaults to audb's own window (last 24h, or the last `audb crash clear` marker).",
      ),
    deviceId: deviceIdField,
  }),
  handler: async (args, ctx) => {
    const { deviceId, platform } = parseCommonArgs(args as Record<string, unknown>, ctx);
    const packageName = args.packageName;

    if (platform === "aurora") {
      const adapter = ctx.deviceManager.getAdapter("aurora", deviceId);
      if (!hasCrashLogs(adapter)) {
        return textResult("Crash listing is not supported for aurora.");
      }
      const events = await adapter.listCrashes({
        package: packageName,
        since: args.since,
      });
      const text = truncateOutput(formatCrashEvents(events, platform, args.since));
      return events.length > 0 ? errorResult(text) : textResult(text);
    }

    const snapshot = await collectSnapshot(ctx, platform, packageName, deviceId);
    const text = truncateOutput(formatCrashes(snapshot.crashes, platform));
    const hasCrashes = snapshot.crashes.length > 0;

    return hasCrashes ? errorResult(text) : textResult(text);
  },
});
