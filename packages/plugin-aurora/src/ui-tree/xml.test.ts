import { describe, expect, it } from "vitest";

import { parseUiHierarchy } from "mcp-devices/ui-tree/ui-parser";

import { parseSemanticsDump, semanticsToUiNodes } from "./semantics.js";
import type { UiTreeNode } from "./types.js";
import { uiNodesToHierarchyXml } from "./xml.js";

function makeNode(overrides: Partial<UiTreeNode> = {}): UiTreeNode {
  return {
    kind: "flutter",
    id: "node",
    className: "Semantics",
    text: "",
    contentDesc: "",
    resourceId: "",
    packageName: "ru.example.app",
    bounds: { x1: 0, y1: 0, x2: 100, y2: 100 },
    clickable: false,
    longClickable: false,
    scrollable: false,
    enabled: true,
    focusable: false,
    focused: false,
    selected: false,
    checkable: false,
    checked: false,
    password: false,
    ...overrides,
  };
}

describe("uiNodesToHierarchyXml", () => {
  it("serializes uiautomator-shaped nodes", () => {
    const xml = uiNodesToHierarchyXml(
      [
        makeNode({
          className: "Button",
          text: "Record",
          bounds: { x1: 10, y1: 20, x2: 110, y2: 140 },
          clickable: true,
          focusable: true,
        }),
      ],
      "ru.example.app",
    );

    expect(xml).toContain('<hierarchy rotation="0">');
    expect(xml).toContain('class="Button"');
    expect(xml).toContain('text="Record"');
    expect(xml).toContain('clickable="true"');
    expect(xml).toContain('focusable="true"');
    expect(xml).toContain('bounds="[10,20][110,140]"');
    expect(xml.trimEnd().endsWith("</hierarchy>")).toBe(true);
  });

  it("escapes XML special characters in attributes", () => {
    const xml = uiNodesToHierarchyXml(
      [
        makeNode({
          text: 'Save & "exit" <now>',
          contentDesc: "AT&T",
        }),
      ],
      "ru.example.app",
    );

    expect(xml).toContain('text="Save &amp; &quot;exit&quot; &lt;now&gt;"');
    expect(xml).toContain('content-desc="AT&amp;T"');
    expect(xml).not.toContain('text="Save & "exit"');
  });

  it("falls back to the snapshot package name and skips invalid bounds", () => {
    const xml = uiNodesToHierarchyXml(
      [
        makeNode({ packageName: "" }),
        makeNode({ bounds: { x1: 50, y1: 50, x2: 50, y2: 100 } }),
        makeNode({ bounds: { x1: 0, y1: 0, x2: Number.NaN, y2: 10 } }),
      ],
      "ru.example.fallback",
    );

    expect((xml.match(/<node /g) ?? []).length).toBe(1);
    expect(xml).toContain('package="ru.example.fallback"');
  });
});

describe("XML round-trip through parseUiHierarchy", () => {
  it("preserves text, entities, bounds and flags", () => {
    const nodes: UiTreeNode[] = [
      makeNode({
        className: "Button",
        text: 'Save & "exit"',
        contentDesc: "AT&T",
        resourceId: "saveButton",
        bounds: { x1: 10, y1: 20, x2: 110, y2: 140 },
        clickable: true,
        enabled: false,
        focusable: true,
        longClickable: true,
      }),
      makeNode({
        className: "EditText",
        text: "Search",
        contentDesc: 'Find "items" <here>',
        bounds: { x1: 0, y1: 200, x2: 360, y2: 260 },
        clickable: true,
        focusable: true,
        focused: true,
        password: true,
        checkable: true,
        checked: true,
        selected: true,
        scrollable: true,
      }),
    ];

    const xml = uiNodesToHierarchyXml(nodes, "ru.example.app");
    const parsed = parseUiHierarchy(xml);

    expect(parsed).toHaveLength(2);

    expect(parsed[0]).toMatchObject({
      resourceId: "saveButton",
      className: "Button",
      packageName: "ru.example.app",
      text: 'Save & "exit"',
      contentDesc: "AT&T",
      clickable: true,
      enabled: false,
      focusable: true,
      longClickable: true,
      bounds: { x1: 10, y1: 20, x2: 110, y2: 140 },
      centerX: 60,
      centerY: 80,
      width: 100,
      height: 120,
    });

    expect(parsed[1]).toMatchObject({
      className: "EditText",
      text: "Search",
      contentDesc: 'Find "items" <here>',
      clickable: true,
      focusable: true,
      focused: true,
      password: true,
      checkable: true,
      checked: true,
      selected: true,
      scrollable: true,
    });
  });

  it("round-trips nodes produced from a Flutter semantics dump", () => {
    const dump = `SemanticsNode#0
 │ Rect.fromLTRB(0.0, 0.0, 720.0, 1600.0)
 │
 └─SemanticsNode#1
     Rect.fromLTRB(0.0, 0.0, 384.0, 853.3) scaled by 1.9x
     │
     └─SemanticsNode#2
         Rect.fromLTRB(20.0, 338.0, 126.7, 462.0)
         flags: isButton
         actions: focus, tap
         label:
           "Record & \\"stop\\""
         textDirection: ltr
`;
    const screen = { width: 360, height: 800 };
    const nodes = semanticsToUiNodes(parseSemanticsDump(dump), screen, "ru.example.recorder");

    const parsed = parseUiHierarchy(uiNodesToHierarchyXml(nodes, "ru.example.recorder"));

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      className: "Button",
      text: 'Record & "stop"',
      clickable: true,
      enabled: true,
      bounds: { x1: 19, y1: 317, x2: 119, y2: 433 },
    });
  });
});
