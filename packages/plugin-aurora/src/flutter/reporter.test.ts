import { describe, expect, it } from "vitest";
import { JsonReporter, escapeXml, renderJUnit } from "./reporter.js";

function event(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

function testStart(id: number, name: string): string {
  return event({
    type: "testStart",
    test: {
      id,
      name,
      suiteID: 0,
      groupIDs: [1],
      metadata: { skip: false, skipReason: null },
      line: 10,
      column: 2,
      url: "package:app/main.dart",
    },
    time: 1,
  });
}

function testDone(
  id: number,
  result: string,
  options: { skipped?: boolean; hidden?: boolean; retried?: boolean; time?: number } = {},
): string {
  return event({
    type: "testDone",
    testID: id,
    result,
    skipped: options.skipped ?? false,
    hidden: options.hidden ?? false,
    retried: options.retried ?? false,
    time: options.time ?? 10,
  });
}

describe("JsonReporter", () => {
  it("summarizes passed, failed and skipped while excluding hidden tests", () => {
    const reporter = new JsonReporter();
    reporter.feed(
      [
        "Some Flutter human-readable output",
        testStart(1, "passes"),
        testDone(1, "success"),
        testStart(2, "fails"),
        testDone(2, "failure"),
        testStart(3, "skipped"),
        testDone(3, "success", { skipped: true }),
        testStart(4, "(tearDownAll)"),
        testDone(4, "success", { hidden: true }),
        event({ type: "done", success: false, time: 20 }),
      ].join("\n"),
    );
    const result = reporter.finalize(1);
    expect(result.summary).toEqual({ passed: 1, failed: 1, skipped: 1, flaky: 0, total: 3 });
    expect(result.complete).toBe(true);
    expect(result.consistencyOk).toBe(true);
    expect(result.done?.success).toBe(false);
  });

  it("treats a successful retry as passed/flaky", () => {
    const reporter = new JsonReporter();
    reporter.feedLine(testStart(1, "flaky"));
    reporter.feedLine(testDone(1, "failure", { retried: true, time: 5 }));
    reporter.feedLine(testStart(1, "flaky"));
    reporter.feedLine(testDone(1, "success", { time: 9 }));
    reporter.feedLine(event({ type: "done", success: true, time: 10 }));
    const result = reporter.finalize(0);
    expect(result.summary).toEqual({ passed: 1, failed: 0, skipped: 0, flaky: 1, total: 1 });
    expect(result.tests[0]?.flaky).toBe(true);
  });

  it("counts an unretried pending retry as failed", () => {
    const reporter = new JsonReporter();
    reporter.feedLine(testStart(1, "attempt"));
    reporter.feedLine(testDone(1, "failure", { retried: true }));
    reporter.feedLine(event({ type: "done", success: false }));
    const result = reporter.finalize(1);
    expect(result.summary.failed).toBe(1);
    expect(result.tests[0]?.result).toBe("error");
  });

  it("downgrades a passed test when a late error arrives after testDone", () => {
    const reporter = new JsonReporter();
    reporter.feedLine(testStart(1, "late"));
    reporter.feedLine(testDone(1, "success"));
    reporter.feedLine(
      event({ type: "error", testID: 1, error: "boom", stackTrace: "trace", time: 11 }),
    );
    reporter.feedLine(event({ type: "done", success: true }));
    const result = reporter.finalize(0);
    expect(result.summary.failed).toBe(1);
    expect(result.tests[0]?.errors).toHaveLength(1);
    expect(result.complete).toBe(false);
    expect(result.warnings.join(" ")).toMatch(/Late error/i);
  });

  it("reports incomplete when done.success is null or done is missing", () => {
    const nullDone = new JsonReporter();
    nullDone.feedLine(testStart(1, "x"));
    nullDone.feedLine(testDone(1, "success"));
    nullDone.feedLine(event({ type: "done", success: null }));
    expect(nullDone.finalize(0).complete).toBe(false);

    const missingDone = new JsonReporter();
    missingDone.feedLine(testStart(1, "x"));
    missingDone.feedLine(testDone(1, "success"));
    expect(missingDone.finalize(0).complete).toBe(false);
  });

  it("classifies exit-code/test-result disagreement as a reporter inconsistency", () => {
    const reporter = new JsonReporter();
    reporter.feedLine(testStart(1, "x"));
    reporter.feedLine(testDone(1, "success"));
    reporter.feedLine(event({ type: "done", success: true }));
    const result = reporter.finalize(1);
    expect(result.consistencyOk).toBe(false);
    expect(result.complete).toBe(false);
  });

  it("ignores human text and records malformed JSON lines", () => {
    const reporter = new JsonReporter();
    reporter.feedLine("Waiting for VM Service...");
    reporter.feedLine('{"type":"testStart" broken');
    reporter.feedLine(testStart(1, "ok"));
    reporter.feedLine(testDone(1, "success"));
    reporter.feedLine(event({ type: "done", success: true }));
    const result = reporter.finalize(0);
    expect(result.malformedLines).toHaveLength(1);
    expect(result.summary.passed).toBe(1);
  });

  it("survives unknown event types and extra fields", () => {
    const reporter = new JsonReporter();
    reporter.feedLine(event({ type: "future-event", payload: { a: 1 } }));
    reporter.feedLine(testStart(1, "ok"));
    reporter.feedLine(testDone(1, "success"));
    reporter.feedLine(event({ type: "done", success: true, newField: 42 }));
    expect(reporter.finalize(0).summary.passed).toBe(1);
  });
});

describe("JUnit rendering", () => {
  it("escapes XML and maps failure/error/skipped", () => {
    const reporter = new JsonReporter();
    reporter.feedLine(testStart(1, "a & b <c>"));
    reporter.feedLine(
      event({ type: "error", testID: 1, error: 'bad <value> & "quote"', stackTrace: "at x < 1" }),
    );
    reporter.feedLine(testDone(1, "failure"));
    reporter.feedLine(testStart(2, "err"));
    reporter.feedLine(event({ type: "error", testID: 2, error: "explode", stackTrace: "" }));
    reporter.feedLine(testDone(2, "error"));
    reporter.feedLine(testStart(3, "skip"));
    reporter.feedLine(testDone(3, "success", { skipped: true }));
    reporter.feedLine(event({ type: "done", success: false }));
    const finalized = reporter.finalize(1);
    const xml = renderJUnit(finalized.tests, { suiteName: "fixture & app" });

    expect(xml).toContain("<failure");
    expect(xml).toContain("<error");
    expect(xml).toContain("<skipped");
    expect(xml).toContain("fixture &amp; app");
    expect(xml).toContain("a &amp; b &lt;c&gt;");
    expect(xml).toContain("bad &lt;value&gt; &amp; &quot;quote&quot;");
  });

  it("adds an infrastructure testcase when no tests were reported", () => {
    const xml = renderJUnit([], {
      suiteName: "fixture",
      infrastructureError: "Build failed <bad>",
    });
    expect(xml).toContain('name="infrastructure"');
    expect(xml).toContain("Build failed &lt;bad&gt;");
  });

  it("removes XML 1.0-invalid control characters", () => {
    expect(escapeXml("a\u0000b\u0001c")).toBe("abc");
  });
});
