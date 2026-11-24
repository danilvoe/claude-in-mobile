/**
 * Parser for the text output of
 * `ext.flutter.debugDumpSemanticsTreeInTraversalOrder`.
 *
 * The dump is a human-oriented tree, not JSON, so this module is deliberately
 * conservative: it understands the fields the Aurora Flutter embedder emits
 * (`Rect.fromLTRB`, `scaled by`, `flags`, `actions`, `label`, `tooltip`,
 * `value`, `hint`, scroll extents) and ignores everything else.
 */

import type { Rect, ScreenGeometry, UiTreeNode } from "./types.js";

export interface SemanticsNode {
  id: string;
  depth: number;
  rect?: Rect;
  scaledBy?: number;
  flags: string[];
  actions: string[];
  label?: string;
  tooltip?: string;
  value?: string;
  hint?: string;
  textDirection?: string;
  scrollPosition?: number;
  scrollExtentMin?: number;
  scrollExtentMax?: number;
}

const NODE_HEADER = /^(.*?)SemanticsNode#(\d+)\s*$/;
const RECT = /^Rect\.fromLTRB\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)(?:\s+scaled by\s+([\d.]+)x)?/;
const DUMP_PROPERTY = /^(?:SemanticsNode#\d+|(?:flags|actions|label|tooltip|value|hint|textDirection|scrollPosition|scrollExtentMin|scrollExtentMax|thickness|elevation|transform|platformViewId):)/;

/** Remove the tree-drawing gutter (`│`, spaces) before a property line. */
function stripGutter(line: string): string {
  return line.replace(/^[\s│]*/, "").trimEnd();
}

/** Remove leading tree glyphs but keep the text (including quotes) intact. */
function stripGutterKeepText(line: string): string {
  return line.replace(/^[\s│]*/, "");
}

/** Compute tree depth from the prefix that precedes `SemanticsNode#`. */
function depthFromPrefix(prefix: string): number {
  if (!prefix) return 0;
  // One level == 2 columns (`│ ` or `  `) plus the final `├─` / `└─`.
  return Math.max(0, Math.round((prefix.length - 1) / 2));
}

/** Decode a quoted dump value. Handles both single-line and multi-line labels. */
export function unquoteDumpValue(raw: string): string {
  let text = raw.trim();
  if (text.startsWith('"') && text.endsWith('"') && text.length >= 2) {
    text = text.slice(1, -1);
  }
  return text.replace(/\\(["nt\\])/g, (_match, ch: string) => {
    if (ch === "n") return "\n";
    if (ch === "t") return "\t";
    return ch;
  });
}

function readQuotedProperty(
  lines: string[],
  startIndex: number,
  firstRemainder: string,
): { value: string; consumed: number } {
  let first = firstRemainder.trim();
  let consumed = 0;
  let index = startIndex;

  // Multi-line labels are emitted as `label:` followed by a quoted line.
  if (!first) {
    const next = stripGutterKeepText(lines[startIndex + 1] ?? "").trim();
    if (!next.startsWith('"')) {
      return { value: "", consumed: 0 };
    }
    first = next;
    index = startIndex + 1;
    consumed = 1;
  }

  if (!first.startsWith('"')) {
    return { value: unquoteDumpValue(first), consumed };
  }

  const parts: string[] = [first];
  let closed = isClosedQuote(first);
  let cursor = index + 1;
  while (!closed && cursor < lines.length) {
    const raw = stripGutterKeepText(lines[cursor]).trimEnd();
    // Stop at the next property/node line if the dump was malformed/truncated.
    if (DUMP_PROPERTY.test(raw.trim()) && !raw.trim().startsWith('"')) {
      break;
    }
    parts.push(raw.trimStart());
    consumed += 1;
    closed = isClosedQuote(raw.trim());
    cursor += 1;
  }
  return { value: unquoteDumpValue(parts.join("\n")), consumed };
}

function isClosedQuote(value: string): boolean {
  if (!value.endsWith('"')) return false;
  let backslashes = 0;
  for (let i = value.length - 2; i >= 0 && value[i] === "\\"; i -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 0;
}

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Parse the raw semantics dump into a flat, depth-tagged node list. */
export function parseSemanticsDump(text: string): SemanticsNode[] {
  const lines = text.split(/\r?\n/);
  const nodes: SemanticsNode[] = [];
  let current: SemanticsNode | undefined;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const header = line.match(NODE_HEADER);
    if (header) {
      const prefix = header[1] ?? "";
      current = {
        id: header[2] ?? "",
        depth: depthFromPrefix(prefix),
        flags: [],
        actions: [],
      };
      nodes.push(current);
      continue;
    }
    if (!current) continue;

    const content = stripGutter(line);
    if (!content) continue;

    const rect = content.match(RECT);
    if (rect) {
      current.rect = {
        x1: Number(rect[1]),
        y1: Number(rect[2]),
        x2: Number(rect[3]),
        y2: Number(rect[4]),
      };
      current.scaledBy = parseNumber(rect[5]);
      continue;
    }

    const property = content.match(/^([a-zA-Z][\w]*):\s*(.*)$/);
    if (!property) continue;
    const key = property[1];
    const remainder = property[2] ?? "";

    switch (key) {
      case "flags":
        current.flags = remainder.split(",").map((part) => part.trim()).filter(Boolean);
        break;
      case "actions":
        current.actions = remainder.split(",").map((part) => part.trim()).filter(Boolean);
        break;
      case "label": {
        const { value, consumed } = readQuotedProperty(lines, i, remainder);
        current.label = value;
        i += consumed;
        break;
      }
      case "tooltip":
      case "value":
      case "hint": {
        const { value, consumed } = readQuotedProperty(lines, i, remainder);
        if (key === "tooltip") current.tooltip = value;
        else if (key === "value") current.value = value;
        else current.hint = value;
        i += consumed;
        break;
      }
      case "textDirection":
        current.textDirection = remainder.trim();
        break;
      case "scrollPosition":
        current.scrollPosition = parseNumber(remainder.trim());
        break;
      case "scrollExtentMin":
        current.scrollExtentMin = parseNumber(remainder.trim());
        break;
      case "scrollExtentMax":
        current.scrollExtentMax = parseNumber(remainder.trim());
        break;
      default:
        break;
    }
  }

  return nodes;
}

function area(rect: Rect): number {
  return Math.max(0, rect.x2 - rect.x1) * Math.max(0, rect.y2 - rect.y1);
}

/**
 * Pick the logical root: the first `scaled by` node (Flutter emits it for the
 * view) or, as a fallback, the largest shallow node.
 */
export function findLogicalRoot(nodes: SemanticsNode[]): SemanticsNode | undefined {
  const scaled = nodes.find((node) => node.rect && node.scaledBy !== undefined);
  if (scaled) return scaled;
  const candidates = nodes.filter((node) => node.rect && node.depth <= 1);
  return candidates.sort((a, b) => area(b.rect!) - area(a.rect!))[0];
}

export interface SemanticsMapping {
  logicalRoot?: SemanticsNode;
  factorX: number;
  factorY: number;
}

/**
 * Flutter semantics rects are in logical pixels; audb input and screenshots
 * use device pixels. The logical root covers the embedder view, so the factor
 * is `screen / logicalView`.
 */
export function computeMapping(
  nodes: SemanticsNode[],
  screen: ScreenGeometry,
): SemanticsMapping {
  const logicalRoot = findLogicalRoot(nodes);
  const width = logicalRoot?.rect ? logicalRoot.rect.x2 - logicalRoot.rect.x1 : 0;
  const height = logicalRoot?.rect ? logicalRoot.rect.y2 - logicalRoot.rect.y1 : 0;
  const factorX = width > 0 && screen.width > 0 ? screen.width / width : 1;
  const factorY = height > 0 && screen.height > 0 ? screen.height / height : 1;
  return { logicalRoot, factorX, factorY };
}

function hasMeaningfulContent(node: SemanticsNode): boolean {
  if (node.label || node.tooltip || node.value || node.hint) return true;
  if (node.actions.some((action) => action === "tap" || action === "longPress")) return true;
  if (node.flags.some((flag) =>
    flag === "isButton"
    || flag === "isTextField"
    || flag === "hasCheckedState"
    || flag === "hasSelectedState"
    || flag === "hasImplicitScrolling"
  )) return true;
  return (node.scrollExtentMax ?? 0) > 0;
}

function classNameFor(node: SemanticsNode): string {
  if (node.flags.includes("isTextField")) return "EditText";
  if (node.flags.includes("isButton")) return "Button";
  if (node.flags.includes("isHeader")) return "TextView";
  if (node.flags.includes("isImage") || node.flags.includes("isImageLabel")) return "Image";
  return "Semantics";
}

/** Convert parsed semantics into the backend-neutral tree. */
export function semanticsToUiNodes(
  semantics: SemanticsNode[],
  screen: ScreenGeometry,
  packageName: string,
): UiTreeNode[] {
  const mapping = computeMapping(semantics, screen);
  const nodes: UiTreeNode[] = [];

  for (const node of semantics) {
    if (!node.rect) continue;
    if (!hasMeaningfulContent(node)) continue;
    const rect = node.rect;
    if (area(rect) <= 0) continue;

    const x1 = clamp(Math.round(rect.x1 * mapping.factorX), 0, screen.width);
    const y1 = clamp(Math.round(rect.y1 * mapping.factorY), 0, screen.height);
    const x2 = clamp(Math.round(rect.x2 * mapping.factorX), 0, screen.width);
    const y2 = clamp(Math.round(rect.y2 * mapping.factorY), 0, screen.height);
    if (x2 <= x1 || y2 <= y1) continue;

    const label = firstNonEmpty(node.label, node.value, node.hint, node.tooltip);
    const contentDesc = firstNonEmpty(
      node.tooltip && node.tooltip !== node.label ? node.tooltip : "",
      node.hint,
    );

    nodes.push({
      kind: "flutter",
      id: node.id,
      className: classNameFor(node),
      text: collapseWhitespace(label),
      contentDesc: collapseWhitespace(contentDesc),
      resourceId: "",
      packageName,
      bounds: { x1, y1, x2, y2 },
      clickable: node.actions.includes("tap")
        || node.flags.includes("isButton")
        || node.flags.includes("isTextField"),
      longClickable: node.actions.includes("longPress"),
      scrollable: node.flags.includes("hasImplicitScrolling")
        || (node.scrollExtentMax ?? 0) > 0,
      enabled: !node.flags.includes("hasEnabledState") || node.flags.includes("isEnabled"),
      focusable: node.flags.includes("isFocusable"),
      focused: node.flags.includes("isFocused"),
      selected: node.flags.includes("isSelected"),
      checkable: node.flags.includes("hasCheckedState"),
      checked: node.flags.includes("isChecked"),
      password: node.flags.includes("isPassword"),
    });
  }

  return nodes;
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    if (value && value.trim().length > 0) return value;
  }
  return "";
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
