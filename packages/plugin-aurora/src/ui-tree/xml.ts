/**
 * Convert backend-neutral Aurora UI nodes into the uiautomator-shaped XML that
 * `parseUiHierarchy` already understands. Keeping this shape means the core
 * `ui.*` actions, element resolution, hints and screenshot annotation need no
 * Aurora-specific branches.
 */

import type { UiTreeNode } from "./types.js";

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function bool(value: boolean): string {
  return value ? "true" : "false";
}

/** Serialize nodes into `<hierarchy><node .../></hierarchy>`. */
export function uiNodesToHierarchyXml(nodes: UiTreeNode[], packageName: string): string {
  const lines = ['<hierarchy rotation="0">'];

  nodes.forEach((node, index) => {
    const bounds = node.bounds;
    if (
      !Number.isFinite(bounds.x1)
      || !Number.isFinite(bounds.y1)
      || !Number.isFinite(bounds.x2)
      || !Number.isFinite(bounds.y2)
      || bounds.x2 <= bounds.x1
      || bounds.y2 <= bounds.y1
    ) {
      return;
    }

    const attrs = [
      `index="${index}"`,
      `text="${escapeAttr(node.text)}"`,
      `resource-id="${escapeAttr(node.resourceId)}"`,
      `class="${escapeAttr(node.className)}"`,
      `package="${escapeAttr(node.packageName || packageName)}"`,
      `content-desc="${escapeAttr(node.contentDesc)}"`,
      `checkable="${bool(node.checkable)}"`,
      `checked="${bool(node.checked)}"`,
      `clickable="${bool(node.clickable)}"`,
      `enabled="${bool(node.enabled)}"`,
      `focusable="${bool(node.focusable)}"`,
      `focused="${bool(node.focused)}"`,
      `scrollable="${bool(node.scrollable)}"`,
      `long-clickable="${bool(node.longClickable)}"`,
      `password="${bool(node.password)}"`,
      `selected="${bool(node.selected)}"`,
      `bounds="[${Math.round(bounds.x1)},${Math.round(bounds.y1)}][${Math.round(bounds.x2)},${Math.round(bounds.y2)}]"`,
    ];
    lines.push(`<node ${attrs.join(" ")} />`);
  });

  lines.push("</hierarchy>");
  return lines.join("\n");
}
