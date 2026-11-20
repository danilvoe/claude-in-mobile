import type { CommandExecutor, CommandResult } from "./flutter-cli.js";

export function commandResult(overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    aborted: false,
    durationMs: 1,
    stdoutTruncated: false,
    stderrTruncated: false,
    ...overrides,
  };
}

export type CommandHandler = (
  command: string,
  args: string[],
  options: Parameters<CommandExecutor>[2],
) => Partial<CommandResult> | Promise<Partial<CommandResult>>;

/** Build a deterministic CommandExecutor for unit tests. */
export function makeExecutor(handler: CommandHandler): CommandExecutor {
  return async (command, args, options) =>
    commandResult(await handler(command, args, options));
}
