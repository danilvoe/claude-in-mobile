import zlib from "node:zlib";

import { describe, expect, it } from "vitest";

import type { AuroraClient } from "../client.js";
import { buildCommandPayload, flattenQtiumTree, parseCompressedPayload, QtiumUiTreeBackend } from "./qtium.js";

const SCREEN = { width: 360, height: 800 };
const PACKAGE = "ru.example.qmlapp";

/** Shape returned by `app:dumpCurrentPage` (plain JSON). */
const PAGE_DUMP = {
  classname: "ApplicationWindow",
  abs_x: 0,
  abs_y: 0,
  width: 360,
  height: 800,
  mainTextProperty: "",
  objectName: "mainWindow",
  enabled: true,
  visible: true,
  children: [
    {
      classname: "Button",
      abs_x: 20,
      abs_y: 100,
      width: 120,
      height: 48,
      mainTextProperty: "Record",
      objectName: "recordButton",
      enabled: true,
      visible: true,
      children: [],
    },
    {
      classname: "TextField",
      // Some builds report numbers as strings.
      abs_x: "20",
      abs_y: "200",
      width: "320",
      height: "48",
      mainTextProperty: "",
      objectName: "searchField",
      enabled: false,
      visible: true,
    },
    {
      classname: "Text",
      abs_x: 20,
      abs_y: 300,
      width: 200,
      height: 24,
      mainTextProperty: "Hidden",
      objectName: "hiddenLabel",
      visible: false,
    },
    {
      classname: "ListView",
      abs_x: 0,
      abs_y: 400,
      width: 360,
      height: 400,
      mainTextProperty: "",
      objectName: "list",
      visible: true,
      children: [
        {
          classname: "ListItem",
          abs_x: 0,
          abs_y: 400,
          width: 360,
          height: 64,
          mainTextProperty: "Item one",
          objectName: "item0",
          visible: true,
        },
      ],
    },
    {
      classname: "Text",
      abs_x: 30,
      abs_y: 500,
      width: 100,
      height: 24,
      mainTextProperty: "No object name",
      // no objectName: id must be synthesized
    },
  ],
};

describe("flattenQtiumTree (app:dumpCurrentPage shape)", () => {
  const nodes = flattenQtiumTree(PAGE_DUMP, PACKAGE, SCREEN);
  const byId = (id: string) => nodes.find((node) => node.id === id);

  it("flattens the tree depth-first and skips invisible nodes", () => {
    expect(nodes.map((node) => node.id)).toEqual([
      "mainWindow",
      "recordButton",
      "searchField",
      "list",
      "item0",
      "Text@30,500",
    ]);
    expect(byId("hiddenLabel")).toBeUndefined();
  });

  it("maps the application window", () => {
    expect(byId("mainWindow")).toMatchObject({
      kind: "qtium",
      className: "ApplicationWindow",
      text: "",
      contentDesc: "",
      resourceId: "mainWindow",
      packageName: PACKAGE,
      bounds: { x1: 0, y1: 0, x2: 360, y2: 800 },
      clickable: false,
      scrollable: false,
      enabled: true,
    });
  });

  it("maps a QML button: clickable, text and objectName", () => {
    expect(byId("recordButton")).toMatchObject({
      className: "Button",
      text: "Record",
      resourceId: "recordButton",
      bounds: { x1: 20, y1: 100, x2: 140, y2: 148 },
      clickable: true,
      enabled: true,
      focusable: false,
      longClickable: false,
    });
  });

  it("maps a QML text field: focused-on-tap input, disabled", () => {
    expect(byId("searchField")).toMatchObject({
      className: "TextField",
      bounds: { x1: 20, y1: 200, x2: 340, y2: 248 },
      clickable: true,
      focusable: true,
      enabled: false,
      password: false,
    });
  });

  it("maps scroll containers and their children", () => {
    expect(byId("list")).toMatchObject({
      className: "ListView",
      scrollable: true,
      clickable: false,
    });
    expect(byId("item0")).toMatchObject({
      className: "ListItem",
      text: "Item one",
      clickable: true,
    });
  });

  it("synthesizes an id from class and position when objectName is missing", () => {
    const synthesized = byId("Text@30,500");

    expect(synthesized).toBeDefined();
    expect(synthesized?.resourceId).toBe("");
    expect(synthesized?.text).toBe("No object name");
    expect(synthesized?.bounds).toEqual({ x1: 30, y1: 500, x2: 130, y2: 524 });
  });

  it("keeps QML coordinates when the dump already uses screen pixels", () => {
    expect(byId("Text@30,500")?.bounds).toEqual({ x1: 30, y1: 500, x2: 130, y2: 524 });
    expect(byId("item0")?.bounds).toEqual({ x1: 0, y1: 400, x2: 360, y2: 464 });
    expect(nodes.every((node) => node.bounds.x2 <= SCREEN.width)).toBe(true);
    expect(nodes.every((node) => node.bounds.y2 <= SCREEN.height)).toBe(true);
  });

  it("returns no nodes for malformed payloads", () => {
    expect(flattenQtiumTree(null, PACKAGE, SCREEN)).toEqual([]);
    expect(flattenQtiumTree("not-a-tree", PACKAGE, SCREEN)).toEqual([]);
    expect(flattenQtiumTree({ classname: "Orphan" }, PACKAGE, SCREEN)).toEqual([]);
  });
});

describe("flattenQtiumTree scaling", () => {
  it("scales a logical QML dump down to the device coordinate space", () => {
    const logical = {
      classname: "ApplicationWindow",
      abs_x: 0,
      abs_y: 0,
      width: 720,
      height: 1600,
      objectName: "window",
      children: [
        {
          classname: "Button",
          abs_x: 40,
          abs_y: 200,
          width: 240,
          height: 100,
          mainTextProperty: "Record",
          objectName: "button",
        },
      ],
    };

    const nodes = flattenQtiumTree(logical, PACKAGE, SCREEN);
    const button = nodes.find((node) => node.id === "button");

    // 720 > 360 * 1.1, so both axes halve.
    expect(nodes.find((node) => node.id === "window")?.bounds).toEqual({
      x1: 0,
      y1: 0,
      x2: 360,
      y2: 800,
    });
    expect(button?.bounds).toEqual({ x1: 20, y1: 100, x2: 140, y2: 150 });
  });

  it("ignores invisible nodes when deciding whether the dump is logical", () => {
    const tree = {
      classname: "ApplicationWindow",
      abs_x: 0,
      abs_y: 0,
      width: 360,
      height: 800,
      objectName: "window",
      children: [
        {
          classname: "Text",
          abs_x: 0,
          abs_y: 0,
          width: 4000,
          height: 4000,
          visible: false,
        },
      ],
    };

    const nodes = flattenQtiumTree(tree, PACKAGE, SCREEN);
    expect(nodes.map((node) => node.id)).toEqual(["window"]);
    expect(nodes[0].bounds).toEqual({ x1: 0, y1: 0, x2: 360, y2: 800 });
  });
});

describe("flattenQtiumTree window geometry (real app:dumpCurrentPage shape)", () => {
  const page = (children: unknown[]) => ({
    classname: "MainPage",
    abs_x: 0,
    abs_y: 68,
    width: 720,
    height: 1532,
    objectName: "mainPage",
    acceptedButtons: 1,
    children,
  });

  it("scales by the root window instead of far-away list delegates", () => {
    const tree = page([
      {
        classname: "LabelBase",
        abs_x: 30,
        abs_y: 573,
        width: 660,
        height: 90,
        mainTextProperty: "Title",
        objectName: "title",
      },
      {
        // A preloaded delegate far below the viewport.
        classname: "ListItem",
        abs_x: 0,
        abs_y: 3533,
        width: 720,
        height: 534,
        acceptedButtons: 1,
        objectName: "offscreenItem",
      },
    ]);

    const nodes = flattenQtiumTree(tree, PACKAGE, SCREEN);

    expect(nodes.map((node) => node.id)).toEqual(["mainPage", "title"]);
    // 720 wide / 1600 logical tall (abs_y + height) -> exactly half.
    expect(nodes[1].bounds).toEqual({ x1: 15, y1: 287, x2: 345, y2: 332 });
  });

  it("drops fully offscreen nodes instead of clamping them onto the edge", () => {
    const tree = page([
      { classname: "ListItem", abs_x: 0, abs_y: 4000, width: 720, height: 500, objectName: "far", acceptedButtons: 1 },
    ]);

    const nodes = flattenQtiumTree(tree, PACKAGE, SCREEN);
    expect(nodes.map((node) => node.id)).toEqual(["mainPage"]);
  });

  it("treats acceptedButtons nodes as clickable and labels as plain text", () => {
    const tree = page([
      { classname: "ListItem", abs_x: 0, abs_y: 194, width: 720, height: 579, acceptedButtons: 1, objectName: "row" },
      { classname: "LabelBase", abs_x: 30, abs_y: 573, width: 660, height: 90, mainTextProperty: "Title", objectName: "label" },
      { classname: "Button", abs_x: 200, abs_y: 800, width: 300, height: 90, mainTextProperty: "Retry", objectName: "button" },
    ]);

    const nodes = flattenQtiumTree(tree, PACKAGE, SCREEN);
    const byId = (id: string) => nodes.find((node) => node.id === id);

    expect(byId("row")?.clickable).toBe(true);
    expect(byId("label")?.clickable).toBe(false);
    expect(byId("button")?.clickable).toBe(true);
    // Full-screen containers accept touches but are not tap targets.
    expect(byId("mainPage")?.clickable).toBe(false);
  });

  it("drops structural containers that carry no text, name or interaction", () => {
    const tree = page([
      { classname: "QQuickItem", abs_x: 0, abs_y: 68, width: 720, height: 400 },
      { classname: "QQuickItem", abs_x: 0, abs_y: 68, width: 720, height: 400, objectName: "layout" },
      { classname: "SilicaFlickable", abs_x: 0, abs_y: 68, width: 720, height: 400, contentY: 0 },
    ]);

    const ids = flattenQtiumTree(tree, PACKAGE, SCREEN).map((node) => node.id);
    expect(ids).toEqual(["mainPage", "layout", "SilicaFlickable@0,68"]);
  });
});

describe("parseCompressedPayload (app:dumpTree shape)", () => {
  it("decodes a base64 + zlib JSON payload", () => {
    const tree = {
      classname: "ApplicationWindow",
      abs_x: 0,
      abs_y: 0,
      width: 360,
      height: 800,
      objectName: "window",
    };
    const compressed = zlib.deflateSync(Buffer.from(JSON.stringify(tree), "utf8")).toString("base64");

    expect(parseCompressedPayload(compressed)).toEqual(tree);
  });

  it("falls back to plain JSON when the build does not compress", () => {
    const tree = { classname: "ApplicationWindow", objectName: "window" };

    expect(parseCompressedPayload(JSON.stringify(tree))).toEqual(tree);
  });

  it("rejects an empty payload", () => {
    expect(() => parseCompressedPayload(undefined)).toThrow(/no tree payload/i);
    expect(() => parseCompressedPayload("")).toThrow();
  });
});

describe("buildCommandPayload", () => {
  it("sends initialize and a flat [command, args] execute payload", () => {
    const lines = buildCommandPayload(PACKAGE, "app:dumpCurrentPage").trimEnd().split("\n");

    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0])).toEqual({
      cmd: "action",
      action: "initialize",
      params: [PACKAGE],
    });
    // The bridge dispatches executeCommand(ITransportClient*, QString, QVariant);
    // a nested `[[command, args]]` payload is silently dropped.
    expect(JSON.parse(lines[1])).toEqual({
      cmd: "action",
      action: "execute",
      params: ["app:dumpCurrentPage", []],
    });
  });

  it("passes command arguments through", () => {
    const lines = buildCommandPayload(PACKAGE, "app:js", ["1 + 1"]).trimEnd().split("\n");

    expect(JSON.parse(lines[1]).params).toEqual(["app:js", ["1 + 1"]]);
  });
});

describe("QtiumUiTreeBackend service state", () => {
  const backendWith = (state: string) => new QtiumUiTreeBackend({
    shellRoot: () => state,
  } as unknown as AuroraClient);

  it("does not treat 'inactive' as active", () => {
    expect(backendWith("inactive").isBridgeActive()).toBe(false);
    expect(backendWith("activating").isBridgeActive()).toBe(true);
    expect(backendWith("active").isBridgeActive()).toBe(true);
  });
});

describe("flattenQtiumTree value coercion", () => {
  it("treats string 'false' visibility and enabled as false", () => {
    const tree = {
      classname: "ApplicationWindow",
      abs_x: 0,
      abs_y: 0,
      width: 360,
      height: 800,
      objectName: "window",
      children: [
        {
          classname: "Text",
          abs_x: 0,
          abs_y: 0,
          width: 100,
          height: 20,
          mainTextProperty: "hidden",
          objectName: "hidden",
          visible: "false",
        },
        {
          classname: "TextField",
          abs_x: 0,
          abs_y: 40,
          width: 100,
          height: 20,
          objectName: "field",
          enabled: "false",
        },
      ],
    };

    const nodes = flattenQtiumTree(tree, PACKAGE, SCREEN);

    expect(nodes.map((node) => node.id)).toEqual(["window", "field"]);
    expect(nodes[1].enabled).toBe(false);
  });
});

describe("flattenQtiumTree scale direction", () => {
  it("scales up when the screen is larger than the logical root", () => {
    const tree = {
      classname: "ApplicationWindow",
      abs_x: 0,
      abs_y: 0,
      width: 360,
      height: 800,
      objectName: "window",
      children: [
        { classname: "Button", abs_x: 10, abs_y: 20, width: 100, height: 40, objectName: "btn" },
      ],
    };

    const nodes = flattenQtiumTree(tree, PACKAGE, { width: 1080, height: 2400 });

    expect(nodes.find((node) => node.id === "btn")?.bounds).toEqual({
      x1: 30,
      y1: 60,
      x2: 330,
      y2: 180,
    });
  });

  it("uses the width ratio when a dialog root does not span the screen height", () => {
    const tree = {
      classname: "Page",
      abs_x: 0,
      abs_y: 400,
      width: 720,
      height: 800,
      objectName: "dialog",
      children: [
        { classname: "Button", abs_x: 100, abs_y: 500, width: 200, height: 80, objectName: "ok" },
      ],
    };

    // ratioX = 360/720 = 0.5, ratioY = 800/1200 = 0.667 -> non-uniform.
    const nodes = flattenQtiumTree(tree, PACKAGE, { width: 360, height: 800 });

    expect(nodes.find((node) => node.id === "ok")?.bounds).toEqual({
      x1: 50,
      y1: 250,
      x2: 150,
      y2: 290,
    });
  });
});
