/**
 * Shared types for the Aurora Flutter/QEMU workflow.
 *
 * The Flutter workflow is deliberately not a separate platform: it orchestrates
 * the official `flutter-aurora` CLI for a normal audb device (`emulator`, later
 * a physical device) and uses audb only for device-scoped artifacts.
 */

export type RunStatus =
  | "completed"
  | "tool_error"
  | "timeout"
  | "cancelled"
  | "internal_error";

export type TestStatus = "passed" | "failed" | "not_run" | "unknown";

export type MappingMethod = "emulatorName" | "id" | "name" | "host";

export interface FlutterDevice {
  id: string;
  name: string;
  targetPlatform?: string;
  emulator?: boolean;
  isSupported?: boolean;
  sdk?: string;
  capabilities?: Record<string, boolean>;
}

export interface FlutterVersion {
  frameworkVersion?: string;
  channel?: string;
  frameworkRevision?: string;
  engineRevision?: string;
  dartSdkVersion?: string;
  devToolsVersion?: string;
  flutterRoot?: string;
  [key: string]: unknown;
}

export interface AudbEmulatorInfo {
  emulatorName?: string;
  qmpSocket?: string;
  sdkRoot?: string;
}

export interface AudbDeviceRecord {
  id: string;
  name: string;
  kind: string;
  state?: string;
  host?: string;
  current?: boolean;
  emulator?: AudbEmulatorInfo;
  [key: string]: unknown;
}

export interface DeviceMapping {
  audbDeviceId: string;
  flutterDeviceId: string;
  method: MappingMethod;
  audbDevice: AudbDeviceRecord;
  flutterDevice: FlutterDevice;
}

export interface DeviceMappingSummary {
  audbDeviceId: string;
  flutterDeviceId: string;
  method: MappingMethod;
}

export interface DevicesReport {
  ok: boolean;
  audbDevices: AudbDeviceRecord[];
  flutterDevices: FlutterDevice[];
  mappings: DeviceMappingSummary[];
  unmatched: Array<{ audbDeviceId: string; reason: string }>;
  warnings: string[];
}

export interface DoctorCheck {
  name: string;
  status: "passed" | "failed" | "warning" | "skipped";
  message?: string;
  data?: unknown;
}

export interface ProjectInfo {
  projectPath: string;
  pubspecPath: string;
  hasFlutterTest: boolean;
  hasIntegrationTest: boolean;
  packageId?: string;
  specFiles: string[];
  declaredPermissions: string[];
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
  warnings: string[];
  flutter?: {
    binary: string;
    realPath?: string;
    version?: FlutterVersion;
    isAuroraBuild?: boolean;
  };
  audb?: {
    binary: string;
    version?: string;
    doctor?: unknown;
    capabilities?: unknown;
  };
  project?: ProjectInfo;
  devices?: DevicesReport;
  mapping?: DeviceMappingSummary;
}

export interface FlutterTestRunInput {
  projectPath: string;
  testPath: string;
  deviceId: string;
  runTimeoutMs: number;
  testTimeout?: number;
  artifactsDir?: string;
  screenshotIntervalMs?: number;
  /**
   * Permission policy for apps that declare Sailjail permissions.
   * - `fail` (default): return PERMISSIONS_REQUIRE_GRANT before launching.
   * - `allow_prompt`: run anyway; an external user must answer the system dialog.
   */
  permissionPolicy?: "fail" | "allow_prompt";
}

export interface ValidatedTestRunInput extends FlutterTestRunInput {
  projectPath: string;
  testPath: string;
  artifactsBaseDir: string;
}

export interface ReporterError {
  error: string;
  stackTrace: string;
}

export interface TestCaseResult {
  id: number;
  name: string;
  suiteID?: number;
  groupIDs?: number[];
  url?: string | null;
  line?: number | null;
  status: "passed" | "failed" | "skipped" | "unknown";
  durationMs?: number;
  retried: boolean;
  flaky: boolean;
  hidden: boolean;
  errors: ReporterError[];
  screenshots: string[];
}

export interface ReporterSummary {
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  total: number;
}

export interface ArtifactError {
  artifact: string;
  message: string;
}

export interface ArtifactPaths {
  dir: string;
  resultJson: string;
  junit: string;
  summary: string;
  testsJson?: string;
  journal?: string;
  crashEvents?: string;
  screenshots: number;
}

export interface CleanupStatus {
  packageId?: string;
  checked: boolean;
  packagePresentBeforeRun?: boolean;
  packagePresentAfterRun?: boolean;
}

export interface PermissionState {
  applicationId: string;
  uid: number;
  declared: string[];
  granted: string[];
  showPrompt: boolean;
  mode?: string;
  alwaysAllowed?: boolean | null;
}

export interface GrantPermissionsOptions {
  permissions?: string[];
  allRequested?: boolean;
  disablePrompt?: boolean;
}

export interface FlutterTestResult {
  schemaVersion: 1;
  ok: boolean;
  runStatus: RunStatus;
  testStatus: TestStatus;
  reporterComplete: boolean;
  artifactsComplete: boolean;
  runId: string;
  deviceId: string;
  flutterDeviceId: string;
  projectPath: string;
  testPath: string;
  startedAt: string;
  finishedAt: string;
  exitCode: number | null;
  durationMs: number;
  summary: ReporterSummary;
  tests: TestCaseResult[];
  artifactErrors: ArtifactError[];
  artifacts: ArtifactPaths;
  cleanup?: CleanupStatus;
  declaredPermissions?: string[];
  permissionPolicy?: "fail" | "allow_prompt";
  reporterWarnings?: string[];
  versions?: {
    flutter?: FlutterVersion;
    audb?: string;
  };
  error?: {
    code: string;
    message: string;
  };
}
