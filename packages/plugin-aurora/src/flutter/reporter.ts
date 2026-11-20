/**
 * JSON reporter state machine + JUnit conversion.
 *
 * The parser is fed line-by-line (stdout mix of human text and NDJSON), keeps
 * opaque IDs, excludes hidden service tests from summaries, separates skipped
 * from passed, treats a successful retry as passed/flaky, and preserves late
 * errors that arrive after `testDone`.
 */

import { redactSecrets } from "./redact.js";
import type { ReporterError, ReporterSummary, TestCaseResult } from "./types.js";

export type ReporterResult = "success" | "failure" | "error" | "pending_retry";

export interface ReporterTest {
  id: number;
  name: string;
  suiteID?: number;
  groupIDs?: number[];
  url?: string | null;
  line?: number | null;
  column?: number | null;
  hidden: boolean;
  skipped: boolean;
  result?: ReporterResult;
  retried: boolean;
  flaky: boolean;
  attemptCount: number;
  failedAttempts: number;
  startedAtMs?: number;
  finishedAtMs?: number;
  lastEventMs?: number;
  errors: ReporterError[];
  prints: string[];
  screenshots: string[];
}

export interface ReporterDoneEvent {
  success: boolean | null;
  time?: number;
}

export interface ReporterFinalizeResult {
  complete: boolean;
  consistencyOk: boolean;
  warnings: string[];
  malformedLines: Array<{ line: number; text: string }>;
  done?: ReporterDoneEvent;
  summary: ReporterSummary;
  tests: ReporterTest[];
}

export interface ReporterOptions {
  onEvent?: (event: Record<string, unknown>, reporter: JsonReporter) => void;
}

const MAX_PRINTS_PER_TEST = 200;
const MAX_PRINT_CHARS = 8_000;

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export class JsonReporter {
  readonly tests = new Map<number, ReporterTest>();
  readonly suites = new Map<number, Record<string, unknown>>();
  readonly groups = new Map<number, Record<string, unknown>>();
  readonly globalErrors: ReporterError[] = [];
  readonly globalPrints: string[] = [];
  readonly malformedLines: Array<{ line: number; text: string }> = [];
  readonly warnings: string[] = [];
  done?: ReporterDoneEvent;
  eventCount = 0;

  private buffer = "";
  private lineNumber = 0;
  private readonly onEvent?: ReporterOptions["onEvent"];

  constructor(options: ReporterOptions = {}) {
    this.onEvent = options.onEvent;
  }

  /** Feed a complete line. Plain non-JSON text is ignored. */
  feedLine(line: string): void {
    this.lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) return;
    if (!trimmed.startsWith("{")) return;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      this.malformedLines.push({ line: this.lineNumber, text: redactSecrets(trimmed.slice(0, 500)) });
      return;
    }
    this.handleEvent(event);
  }

  /** Feed a stdout/stderr chunk that may contain partial lines. */
  feed(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.feedLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  /** Flush a trailing partial line. */
  flush(): void {
    if (!this.buffer) return;
    const line = this.buffer.replace(/\r$/, "");
    this.buffer = "";
    this.feedLine(line);
  }

  private handleEvent(event: Record<string, unknown>): void {
    this.eventCount += 1;
    try {
      this.onEvent?.(event, this);
    } catch {
      // Observer callbacks must never break parsing.
    }

    const type = asString(event.type);
    switch (type) {
      case "suite": {
        const suite = event.suite;
        if (suite && typeof suite === "object") {
          const id = asNumber((suite as Record<string, unknown>).id);
          if (id !== undefined) this.suites.set(id, suite as Record<string, unknown>);
        }
        break;
      }
      case "group": {
        const group = event.group;
        if (group && typeof group === "object") {
          const id = asNumber((group as Record<string, unknown>).id);
          if (id !== undefined) this.groups.set(id, group as Record<string, unknown>);
        }
        break;
      }
      case "testStart": {
        const test = event.test;
        if (!test || typeof test !== "object") break;
        const raw = test as Record<string, unknown>;
        const id = asNumber(raw.id);
        if (id === undefined) break;
        const metadata = (raw.metadata ?? {}) as Record<string, unknown>;
        const existing = this.tests.get(id);
        if (existing) {
          existing.startedAtMs ??= asNumber(event.time);
          existing.lastEventMs = asNumber(event.time) ?? existing.lastEventMs;
          break;
        }
        this.tests.set(id, {
          id,
          name: asString(raw.name) ?? `test ${id}`,
          suiteID: asNumber(raw.suiteID),
          groupIDs: Array.isArray(raw.groupIDs)
            ? raw.groupIDs.filter((value): value is number => typeof value === "number")
            : undefined,
          url: asString(raw.url) ?? null,
          line: asNumber(raw.line) ?? null,
          column: asNumber(raw.column) ?? null,
          hidden: false,
          skipped: metadata.skip === true,
          retried: false,
          flaky: false,
          attemptCount: 0,
          failedAttempts: 0,
          startedAtMs: asNumber(event.time),
          lastEventMs: asNumber(event.time),
          errors: [],
          prints: [],
          screenshots: [],
        });
        break;
      }
      case "print": {
        const message = redactSecrets((asString(event.message) ?? "").slice(0, MAX_PRINT_CHARS));
        const testId = asNumber(event.testID);
        const test = testId !== undefined ? this.tests.get(testId) : undefined;
        if (test) {
          if (test.prints.length < MAX_PRINTS_PER_TEST) test.prints.push(message);
        } else if (this.globalPrints.length < MAX_PRINTS_PER_TEST) {
          this.globalPrints.push(message);
        }
        break;
      }
      case "error": {
        const error: ReporterError = {
          error: redactSecrets(asString(event.error) ?? ""),
          stackTrace: redactSecrets(asString(event.stackTrace) ?? ""),
        };
        const testId = asNumber(event.testID);
        const test = testId !== undefined ? this.tests.get(testId) : undefined;
        if (test) {
          test.errors.push(error);
          if (test.result === "success" || test.result === "pending_retry") {
            test.result = "error";
            test.flaky = false;
            this.warnings.push(
              `Late error event after testDone for test ${test.id} (${test.name}); result downgraded to error.`,
            );
          }
          test.lastEventMs = asNumber(event.time) ?? test.lastEventMs;
        } else {
          this.globalErrors.push(error);
          this.warnings.push("Reporter emitted an error event without a matching testID.");
        }
        break;
      }
      case "testDone": {
        const testId = asNumber(event.testID);
        const test = testId !== undefined ? this.tests.get(testId) : undefined;
        if (!test) {
          this.warnings.push("Reporter emitted testDone for an unknown testID.");
          break;
        }
        const result = asString(event.result);
        const retried = event.retried === true;
        const time = asNumber(event.time);
        test.attemptCount += 1;
        test.hidden = event.hidden === true;
        test.skipped = event.skipped === true;
        test.retried = retried;
        test.lastEventMs = time ?? test.lastEventMs;

        if (result === "success") {
          test.result = "success";
          test.finishedAtMs = time;
          test.flaky = test.failedAttempts > 0;
        } else if (result === "failure" || result === "error") {
          test.failedAttempts += 1;
          test.result = retried ? "pending_retry" : result;
          test.finishedAtMs = retried ? undefined : time;
        } else {
          test.result = "error";
          this.warnings.push(`Unknown testDone.result '${String(result)}' for test ${test.id}.`);
          test.finishedAtMs = time;
        }
        break;
      }
      case "done": {
        this.done = {
          success: typeof event.success === "boolean" ? event.success : null,
          time: asNumber(event.time),
        };
        break;
      }
      default:
        // Unknown event types and new fields are intentionally tolerated.
        break;
    }
  }

  finalize(exitCode: number | null): ReporterFinalizeResult {
    this.flush();
    const warnings = [...this.warnings];

    for (const test of this.tests.values()) {
      if (test.result === "pending_retry") {
        // The final attempt was marked for retry but no retry ever completed.
        test.result = "error";
        test.finishedAtMs ??= test.lastEventMs;
      }
    }

    const visible = [...this.tests.values()].filter((test) => !test.hidden);
    const summary = summarize(visible);

    const testsIndicateSuccess = summary.failed === 0 && summary.total > 0;
    let consistencyOk = true;
    let complete = true;

    if (!this.done) {
      complete = false;
      warnings.push("Reporter did not emit a done event.");
    } else if (typeof this.done.success !== "boolean") {
      complete = false;
      warnings.push("Reporter emitted done.success = null/missing.");
    } else {
      if (summary.total > 0 && this.done.success !== testsIndicateSuccess) {
        consistencyOk = false;
        warnings.push(
          `Reporter inconsistency: done.success=${String(this.done.success)} but ${summary.failed} failed of ${summary.total} visible tests.`,
        );
      }
      if (exitCode !== null && this.done.success !== (exitCode === 0)) {
        consistencyOk = false;
        warnings.push(
          `Reporter inconsistency: done.success=${String(this.done.success)} but child exitCode=${exitCode}.`,
        );
      }
      if (summary.total > 0 && summary.failed > 0 && exitCode === 0) {
        consistencyOk = false;
        warnings.push(
          "Reporter inconsistency: failed tests were reported but the child exitCode is 0.",
        );
      }
    }

    if (!consistencyOk) complete = false;

    return {
      complete,
      consistencyOk,
      warnings,
      malformedLines: [...this.malformedLines],
      done: this.done,
      summary,
      tests: visible,
    };
  }
}

function summarize(visible: ReporterTest[]): ReporterSummary {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let flaky = 0;
  for (const test of visible) {
    if (test.skipped) {
      skipped += 1;
      continue;
    }
    if (test.result === "success") {
      passed += 1;
      if (test.flaky) flaky += 1;
    } else if (test.result === "failure" || test.result === "error" || test.result === "pending_retry") {
      failed += 1;
    } else {
      // A test without testDone is not counted as passed.
      failed += 1;
    }
  }
  return { passed, failed, skipped, flaky, total: visible.length };
}

export function testStatusOf(test: ReporterTest): TestCaseResult["status"] {
  if (test.skipped) return "skipped";
  if (test.result === "success") return "passed";
  if (test.result === "failure" || test.result === "error" || test.result === "pending_retry") {
    return "failed";
  }
  return "unknown";
}

export interface JUnitOptions {
  suiteName?: string;
  infrastructureError?: string;
}

const INVALID_XML_CHARS = /[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]/g;

export function escapeXml(value: string): string {
  return value
    .replace(INVALID_XML_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function seconds(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return "0.000";
  return (ms / 1000).toFixed(3);
}

/**
 * Convert reporter tests to JUnit XML. Adds an infrastructure testcase with
 * `<error>` when there are no visible tests and an infrastructure failure is
 * supplied (build failure, missing reporter, timeout, ...).
 */
export function renderJUnit(
  tests: ReporterTest[],
  options: JUnitOptions = {},
): string {
  const visible = tests.filter((test) => !test.hidden);
  const summary = summarize(visible);
  const suiteName = options.suiteName ?? "flutter-aurora";

  let failures = 0;
  let errors = 0;
  let skipped = 0;
  let totalTimeMs = 0;
  const cases: string[] = [];

  for (const test of visible) {
    const durationMs =
      test.finishedAtMs !== undefined && test.startedAtMs !== undefined
        ? Math.max(0, test.finishedAtMs - test.startedAtMs)
        : undefined;
    if (durationMs !== undefined) totalTimeMs += durationMs;
    const status = testStatusOf(test);
    const errorText = test.errors
      .map((item) => (item.stackTrace ? `${item.error}\n${item.stackTrace}` : item.error))
      .join("\n\n");
    const className = test.url ?? "flutter";

    if (status === "skipped") {
      skipped += 1;
      cases.push(
        `    <testcase classname="${escapeXml(className)}" name="${escapeXml(test.name)}" time="${seconds(durationMs)}">\n      <skipped/>\n    </testcase>`,
      );
      continue;
    }

    if (status === "failed") {
      const kind = test.result === "failure" ? "failure" : "error";
      if (kind === "failure") failures += 1;
      else errors += 1;
      const message = test.errors[0]?.error ?? "Test failed without an error message.";
      cases.push(
        `    <testcase classname="${escapeXml(className)}" name="${escapeXml(test.name)}" time="${seconds(durationMs)}">\n      <${kind} message="${escapeXml(message)}" type="${kind}">${escapeXml(errorText)}</${kind}>\n    </testcase>`,
      );
      continue;
    }

    cases.push(
      `    <testcase classname="${escapeXml(className)}" name="${escapeXml(test.name)}" time="${seconds(durationMs)}">\n    </testcase>`,
    );
  }

  if (visible.length === 0 && options.infrastructureError) {
    errors += 1;
    cases.push(
      `    <testcase classname="${escapeXml(suiteName)}" name="infrastructure" time="0.000">\n      <error message="${escapeXml(options.infrastructureError)}" type="infrastructure">${escapeXml(options.infrastructureError)}</error>\n    </testcase>`,
    );
  }

  const testsCount = visible.length === 0 && options.infrastructureError ? 1 : visible.length;

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites tests="${testsCount}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${seconds(totalTimeMs)}">`,
    `  <testsuite name="${escapeXml(suiteName)}" tests="${testsCount}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${seconds(totalTimeMs)}">`,
    ...cases,
    "  </testsuite>",
    "</testsuites>",
    "",
  ].join("\n");
}

export function renderSummaryText(result: {
  ok: boolean;
  runStatus: string;
  testStatus: string;
  exitCode: number | null;
  durationMs: number;
  summary: ReporterSummary;
  artifactErrors: unknown[];
  artifacts: { dir: string };
}): string {
  return [
    `ok: ${result.ok}`,
    `runStatus: ${result.runStatus}`,
    `testStatus: ${result.testStatus}`,
    `exitCode: ${result.exitCode === null ? "null" : result.exitCode}`,
    `durationMs: ${result.durationMs}`,
    `tests: ${result.summary.passed} passed, ${result.summary.failed} failed, ${result.summary.skipped} skipped, ${result.summary.flaky} flaky`,
    `artifactErrors: ${result.artifactErrors.length}`,
    `artifacts: ${result.artifacts.dir}`,
    "",
  ].join("\n");
}
