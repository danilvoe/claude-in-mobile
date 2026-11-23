/**
 * Shared types for Aurora UI-tree backends.
 *
 * Both backends (Flutter VM Service semantics and qtium QML dumps) produce
 * `UiTreeSnapshot` values. `xml.ts` turns them into the uiautomator-shaped XML
 * that the core `parseUiHierarchy` understands, so `ui.*`, `input_tap(text)`,
 * hints and screenshot annotation work without platform-specific branches.
 */

export type UiTreeBackendKind = "flutter" | "qtium";

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface ScreenGeometry {
  width: number;
  height: number;
}

/**
 * Backend-neutral node. Bounds are already in device (audb/QMP) coordinates.
 * `index` is assigned in document order by the XML converter.
 */
export interface UiTreeNode {
  kind: UiTreeBackendKind;
  /** Stable backend identifier (semantics node id, QML objectName, ...). */
  id: string;
  className: string;
  text: string;
  contentDesc: string;
  resourceId: string;
  packageName: string;
  bounds: Rect;
  clickable: boolean;
  longClickable: boolean;
  scrollable: boolean;
  enabled: boolean;
  focusable: boolean;
  focused: boolean;
  selected: boolean;
  checkable: boolean;
  checked: boolean;
  password: boolean;
}

export interface UiTreeSnapshot {
  backend: UiTreeBackendKind;
  packageName: string;
  screen: ScreenGeometry;
  nodes: UiTreeNode[];
  /** Backend-specific diagnostics, never contains tokens or VM Service URIs. */
  metadata?: Record<string, unknown>;
}

export class UiTreeUnavailableError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(message: string, code: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "UiTreeUnavailableError";
    this.code = code;
    this.details = details;
  }
}

export class UiTreeSetupRequiredError extends UiTreeUnavailableError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, "UI_TREE_SETUP_REQUIRED", details);
    this.name = "UiTreeSetupRequiredError";
  }
}
