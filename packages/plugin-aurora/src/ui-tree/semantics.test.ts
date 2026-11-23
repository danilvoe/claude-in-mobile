import { describe, expect, it } from "vitest";

import {
  computeMapping,
  findLogicalRoot,
  parseSemanticsDump,
  semanticsToUiNodes,
  unquoteDumpValue,
} from "./semantics.js";

/**
 * Realistic dump of `ext.flutter.debugDumpSemanticsTreeInTraversalOrder` from
 * an Aurora Flutter app. Layout notes that matter for the parser:
 *   - node 0 is the physical root (device pixels 720x1600),
 *   - node 1 is the embedder view (logical pixels 384x853.3, scaled by 1.9x),
 *   - multi-line labels put the opening quote on the *next* line,
 *   - embedded quotes are escaped as `\"`.
 */
const DUMP = `SemanticsNode#0
 │ Rect.fromLTRB(0.0, 0.0, 720.0, 1600.0)
 │
 └─SemanticsNode#1
     Rect.fromLTRB(0.0, 0.0, 384.0, 853.3) scaled by 1.9x
     flags: isSemanticBoundary, hasImplicitScrolling
     scrollExtentMin: 0.0
     scrollExtentMax: 128.0
     textDirection: ltr
     │
     ├─SemanticsNode#2
     │   Rect.fromLTRB(20.0, 338.0, 126.7, 462.0)
     │   flags: isButton
     │   actions: focus, tap
     │   label:
     │     "Record"
     │   textDirection: ltr
     │
     ├─SemanticsNode#3
     │   Rect.fromLTRB(20.0, 500.0, 340.0, 600.0)
     │   label:
     │     "Recordings are saved
     │     to the device
     │     storage."
     │   textDirection: ltr
     │
     ├─SemanticsNode#4
     │   Rect.fromLTRB(20.0, 640.0, 340.0, 700.0)
     │   flags: isTextField, hasEnabledState, isEnabled, isFocusable, isPassword
     │   actions: focus, tap
     │   hint: "Search"
     │   textDirection: ltr
     │
     └─SemanticsNode#5
         Rect.fromLTRB(20.0, 720.0, 340.0, 780.0)
         flags: isButton, hasEnabledState
         actions: focus, tap
         label:
           "Save & \\"exit\\""
         textDirection: ltr
`;

const SCREEN = { width: 360, height: 800 };
const PACKAGE = "ru.example.recorder";

describe("parseSemanticsDump", () => {
  it("parses node headers, depths and rects", () => {
    const nodes = parseSemanticsDump(DUMP);

    expect(nodes.map((node) => node.id)).toEqual(["0", "1", "2", "3", "4", "5"]);
    expect(nodes.map((node) => node.depth)).toEqual([0, 1, 3, 3, 3, 3]);

    expect(nodes[0].rect).toEqual({ x1: 0, y1: 0, x2: 720, y2: 1600 });
    expect(nodes[0].scaledBy).toBeUndefined();

    expect(nodes[1].rect).toEqual({ x1: 0, y1: 0, x2: 384, y2: 853.3 });
    expect(nodes[1].scaledBy).toBe(1.9);
    expect(nodes[1].flags).toEqual(["isSemanticBoundary", "hasImplicitScrolling"]);
    expect(nodes[1].scrollExtentMax).toBe(128);
    expect(nodes[1].scrollExtentMin).toBe(0);
    expect(nodes[1].textDirection).toBe("ltr");
  });

  it("parses button actions and its quoted label", () => {
    const button = parseSemanticsDump(DUMP)[2];

    expect(button.actions).toEqual(["focus", "tap"]);
    expect(button.flags).toEqual(["isButton"]);
    expect(button.label).toBe("Record");
  });

  it("joins a multi-line label whose opening quote is on the next line", () => {
    const label = parseSemanticsDump(DUMP)[3].label;

    expect(label).toBe("Recordings are saved\nto the device\nstorage.");
  });

  it("does not stop a multi-line label at property-like text", () => {
    const dump = `SemanticsNode#0
 └─SemanticsNode#1
     Rect.fromLTRB(0.0, 0.0, 100.0, 50.0)
     label:
       "First line
       Note: second line
       https://example.test/x"
     textDirection: ltr
`;
    expect(parseSemanticsDump(dump)[1].label).toBe(
      "First line\nNote: second line\nhttps://example.test/x",
    );
  });

  it("parses text-field flags, hint and escaped quotes", () => {
    const nodes = parseSemanticsDump(DUMP);
    const field = nodes[4];
    const escaped = nodes[5];

    expect(field.flags).toEqual([
      "isTextField",
      "hasEnabledState",
      "isEnabled",
      "isFocusable",
      "isPassword",
    ]);
    expect(field.hint).toBe("Search");
    expect(field.label).toBeUndefined();

    expect(escaped.label).toBe('Save & "exit"');
  });

  it("unquotes dump values without breaking escaped quotes", () => {
    expect(unquoteDumpValue('"a \\"b\\" c"')).toBe('a "b" c');
    expect(unquoteDumpValue('"line1\\nline2"')).toBe("line1\nline2");
    expect(unquoteDumpValue("plain")).toBe("plain");
  });
});

describe("computeMapping", () => {
  it("prefers the scaled logical node as the root", () => {
    const nodes = parseSemanticsDump(DUMP);
    const root = findLogicalRoot(nodes);

    expect(root?.id).toBe("1");
  });

  it("maps logical pixels to device pixels (360/384)", () => {
    const mapping = computeMapping(parseSemanticsDump(DUMP), SCREEN);

    expect(mapping.factorX).toBe(0.9375);
    expect(mapping.factorX).toBe(360 / 384);
    expect(mapping.factorY).toBeCloseTo(800 / 853.3, 10);
    expect(mapping.factorY).not.toBe(mapping.factorX);
  });
});

describe("semanticsToUiNodes", () => {
  const uiNodes = semanticsToUiNodes(parseSemanticsDump(DUMP), SCREEN, PACKAGE);
  const byId = (id: string) => uiNodes.find((node) => node.id === id);

  it("drops the physical root (no semantics content) and keeps the logical root", () => {
    expect(byId("0")).toBeUndefined();

    const root = byId("1");
    expect(root).toBeDefined();
    expect(root?.bounds).toEqual({ x1: 0, y1: 0, x2: 360, y2: 800 });
    expect(root?.scrollable).toBe(true);
    expect(root?.className).toBe("Semantics");
  });

  it("maps the Record button to Button with device bounds", () => {
    const button = byId("2");

    expect(button).toMatchObject({
      kind: "flutter",
      className: "Button",
      text: "Record",
      contentDesc: "",
      packageName: PACKAGE,
      clickable: true,
      enabled: true,
      password: false,
    });
    // x * 360/384, y * 800/853.3, then rounded.
    expect(button?.bounds).toEqual({ x1: 19, y1: 317, x2: 119, y2: 433 });
  });

  it("collapses a multi-line label into single-line node text", () => {
    const label = byId("3");

    expect(label?.className).toBe("Semantics");
    expect(label?.text).toBe("Recordings are saved to the device storage.");
    expect(label?.clickable).toBe(false);
    expect(label?.bounds).toEqual({ x1: 19, y1: 469, x2: 319, y2: 563 });
  });

  it("maps the text field to EditText with enabled/focusable/password flags", () => {
    const field = byId("4");

    expect(field).toMatchObject({
      className: "EditText",
      text: "Search",
      contentDesc: "Search",
      clickable: true,
      enabled: true,
      focusable: true,
      focused: false,
      password: true,
    });
    expect(field?.bounds).toEqual({ x1: 19, y1: 600, x2: 319, y2: 656 });
  });

  it("marks hasEnabledState without isEnabled as disabled and keeps escaped text", () => {
    const save = byId("5");

    expect(save?.className).toBe("Button");
    expect(save?.text).toBe('Save & "exit"');
    expect(save?.enabled).toBe(false);
    expect(save?.clickable).toBe(true);
  });

  it("returns an empty list when no node has a rect", () => {
    expect(semanticsToUiNodes([], SCREEN, PACKAGE)).toEqual([]);
  });
});
