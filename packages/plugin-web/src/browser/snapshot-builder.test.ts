import { describe, expect, it } from "vitest";

import type { CDPAccessibilityNode, CDPClientInterface } from "./cdp-types.js";
import { buildSnapshot } from "./snapshot-builder.js";
import type { BrowserSession } from "./types.js";

function axValue(type: string, value: string) {
  return { type, value };
}

function node(
  partial: Partial<CDPAccessibilityNode> & { role?: string | { type: string; value: string } },
): CDPAccessibilityNode {
  const { role, ...rest } = partial;
  return {
    nodeId: String(Math.random()),
    ignored: false,
    ...(role
      ? { role: typeof role === "string" ? axValue("role", role) : role }
      : {}),
    ...rest,
  };
}

function fakeCdp(nodes: CDPAccessibilityNode[]): CDPClientInterface {
  const calls: string[] = [];
  const cdp = {
    Accessibility: { getFullAXTree: async () => ({ nodes }) },
    DOM: {
      getDocument: async () => {
        calls.push("getDocument");
        return { root: { nodeId: 1 } };
      },
      pushNodesByBackendIdsToFrontend: async ({ backendNodeIds }: { backendNodeIds: number[] }) => {
        if (!calls.includes("getDocument")) {
          throw new Error("Document needs to be requested first");
        }
        return { nodeIds: backendNodeIds.map((id) => id + 1000) };
      },
      resolveNode: async ({ nodeId }: { nodeId: number }) => ({
        object: { objectId: `obj-${nodeId}` },
      }),
    },
    Runtime: {
      callFunctionOn: async ({ objectId }: { objectId: string }) => ({
        result: { value: `#sel-${objectId}` },
      }),
      evaluate: async ({ expression }: { expression: string }) => ({
        result: { value: expression === "document.title" ? "Test Page" : "http://localhost/page" },
      }),
    },
    calls,
  };
  return cdp as unknown as CDPClientInterface;
}

function session(): BrowserSession {
  return {
    refMap: new Map(),
    lastRefCounter: 0,
    url: "",
  } as unknown as BrowserSession;
}

describe("buildSnapshot AX projection", () => {
  it("parses real CDP role records and emits clickable refs", async () => {
    const s = session();
    const cdp = fakeCdp([
      node({ role: "button", name: axValue("computedString", "Save"), backendDOMNodeId: 7 }),
      node({ role: "link", name: axValue("computedString", "Docs"), backendDOMNodeId: 8 }),
    ]);
    const output = await buildSnapshot(s, cdp);

    expect(output).toContain('button "Save" [e1]');
    expect(output).toContain('link "Docs" [e2]');
    expect(output).toContain("2 interactive elements, refs e1..e2");
    expect((cdp as unknown as { calls: string[] }).calls.filter((call) => call === "getDocument"))
      .toHaveLength(1);
    expect(s.refMap.get("e1")).toMatchObject({
      selector: "#sel-obj-1007",
      backendNodeId: 7,
      label: 'button "Save"',
    });
    expect(s.refMap.get("e2")?.selector).toBe("#sel-obj-1008");
  });

  it("drops internal AX roles and non-semantic containers", async () => {
    const s = session();
    const output = await buildSnapshot(s, fakeCdp([
      node({ role: axValue("internalRole", "InlineTextBox"), name: axValue("computedString", "text") }),
      node({ role: axValue("internalRole", "StaticText"), name: axValue("computedString", "text") }),
      node({ role: "generic", name: axValue("computedString", "") }),
      node({ role: "none" }),
      node({ role: "heading", name: axValue("computedString", "Title") }),
    ]));

    expect(output).not.toContain("InlineTextBox");
    expect(output).not.toContain("StaticText");
    expect(output).not.toContain("generic");
    expect(output).toContain('heading "Title"');
    expect(output).toContain("0 interactive elements");
    expect(output).not.toContain("refs e1..e0");
  });

  it("keeps lines readable and only refs interactive roles with a name", async () => {
    const s = session();
    const output = await buildSnapshot(s, fakeCdp([
      node({ role: "button", name: axValue("computedString", "") }),
      node({
        role: "textbox",
        name: axValue("computedString", "Email"),
        value: axValue("string", "a@b.c"),
        properties: [{ name: "disabled", value: { value: true } }],
      }),
    ]));

    expect(output).toContain('button ""');
    expect(output).toContain('textbox "Email" [e1] value="a@b.c" [disabled]');
    expect(s.refMap.size).toBe(1);
  });

  it("matches AX role only for type=role, not for a string-typed value", async () => {
    const s = session();
    const output = await buildSnapshot(s, fakeCdp([
      node({ role: undefined, name: axValue("computedString", "x") }),
    ]));

    expect(output).toContain("(no interactive elements found)");
    expect(s.refMap.size).toBe(0);
  });
});
