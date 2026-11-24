# Platform Plugin: Aurora

Automate Aurora OS applications via audb and Aurora Flutter SDK.

---

## Overview

Enables Aurora OS app automation: screenshot, touch, text input, app lifecycle, shell access, and UI-tree inspection when the target app exposes a supported backend. Aurora OS is a Linux-based mobile operating system, and mcp-devices provides an ADB-like interface for automation.

## When to use it

- **Aurora app testing:** Automate workflows on Aurora OS devices/emulators
- **Cross-platform testing:** Test same app codebase on Aurora alongside Android
- **UI automation:** Navigate app screens, fill forms, verify state through a Flutter semantics or Qt/QML tree
- **System access:** Execute commands, read logs, access device info
- **Screenshot capture:** Capture screenshots for manual review or comparison in external tooling (the `visual` module is not available on Aurora)
- **UI inspection:** Inspect labels, roles, flags, and bounds exposed by Flutter debug/profile builds or third-party QML apps

---

## Prerequisites

### Aurora Flutter SDK

Required for Aurora OS automation.

**Install:**

Follow Aurora Linux documentation for SDK installation. Typically:

```sh
# Example (varies by Aurora distribution)
# Via package manager
sudo apt-get install aurora-sdk

# Or download from Aurora Linux developer resources
# https://gitlab.com/auroraos/
```

**Verify:**

`mcp-devices doctor aurora` probes for `flutter-aurora` (the Aurora Flutter SDK).
The plugin talks to devices over `audb` (an ADB-like transport) at runtime.

```sh
flutter-aurora --version    # what `mcp-devices doctor aurora` checks
audb version                # device transport used by the plugin at runtime
```

**Check status:**

```sh
mcp-devices doctor aurora
```

This verifies Aurora SDK is installed and lists connected devices/emulators.

### Aurora Devices

- **Emulator:** Aurora emulator instances created via Aurora Flutter SDK
- **Physical device:** Aurora OS device with USB debugging enabled

### Location emulation

`sensor(action: 'location')` and `sensor(action: 'track')` drive the Aurora emulator's
GeoClue emulation service through `audb location ...`. Requirements:

- `audb >= 0.4.2` in `PATH`;
- a running Aurora **emulator** (physical devices reject the command with
  `CAPABILITY_UNAVAILABLE`);
- the app under test must declare the `Location` permission.

The service is exposed on the emulator's **system** D-Bus (`ru.omp.GeoclueEmulationManagement`),
not the session bus some Aurora documentation mentions. `audb` handles that detail.

#### Autotest recipe

```sh
# Once per job
audb emulator start
until audb --device emulator status --json | grep -q '"connected":true'; do sleep 2; done
```

```json
// tests/fixtures/gps/route-line.json
{
  "positions": [
    { "latitude": 59.9311, "longitude": 30.3609, "altitude": 10, "intervalMs": 1000 },
    { "latitude": 59.9315, "longitude": 30.3615, "altitude": 10, "intervalMs": 1000 }
  ]
}
```

```
// beforeEach
sensor(action: 'track', platform: 'aurora', operation: 'load', file: 'tests/fixtures/gps/route-line.json')
sensor(action: 'track', platform: 'aurora', operation: 'start')

// afterEach — stop playback and reset to a known point
sensor(action: 'track', platform: 'aurora', operation: 'stop')
sensor(action: 'location', platform: 'aurora', latitude: 59.9311, longitude: 30.3609)
```

Run location tests sequentially on a single emulator; `audb` serializes commands per device,
but concurrent scenarios would still fight over the same simulated position.
NMEA (`.nmea`) conversion is not part of this plugin: convert `$GPGGA`/`$GPRMC` fixes to the
JSON shape above in the test repository.

---

## Install & Enable

### 1. Install npm package

```sh
npm i -g @mcp-devices/plugin-aurora
```

### 2. Enable the platform

```sh
mcp-devices install aurora
```

### 3. Restart MCP server

Aurora platform loads on next server start.

### 4. Verify

```sh
mcp-devices platforms
# Output: "aurora: enabled"

mcp-devices doctor aurora
# Lists connected devices & emulators
```

---

## Tools & Actions

Aurora uses the same core modules as Android over an ADB-like interface. Element-based
actions require a UI tree backend (see [UI Tree Backends](#ui-tree-backends)).

| Module | Key Actions | Use |
|--------|-------------|-----|
| **input** | `tap` (coords or `text`), `double_tap`, `long_press`, `swipe`, `text`, `key` | Touch gestures, text input, keyboard |
| **ui** | `tree`, `find`, `find_tap`, `tap_text`, `wait`, `assert_visible`, `assert_gone` | Element search, assertions, waits (requires a UI tree backend) |
| **app** | `launch`, `stop`, `install`, `list` | App lifecycle |
| **system** | `shell`, `logs`, `info` | Low-level control, device info |
| **sensor** | `location`, `track` | GPS position and track emulation (emulator only, `audb >= 0.4.2`) |
| **screen** | `capture`, `annotate` | Screenshots (`annotate` requires a UI tree backend) |
| **device** | `list`, `set_target`, `enable_module` | Device management; `enable_module` only loads tool schemas |
| **flow** | `batch`, `run`, `parallel` | Multi-step automation |

Not available on Aurora: `performance`, `visual`, `accessibility`. The Aurora adapter does
not implement those capabilities, and `device(action: 'enable_module')` only loads the tool
schemas — it does not add platform support. `ui(action: 'analyze')` works when a UI tree
backend is available.

### Example invocations (action syntax)

```json
// Tap screen coordinates (screenshot pixel space, auto-scaled to device space)
input(action: 'tap', x: 540, y: 1200)

// Tap an element by text through the UI tree
input(action: 'tap', text: 'Login')

// Fuzzy tap by description (requires a UI tree backend)
ui(action: 'find_tap', description: 'login button')

// Type text
input(action: 'text', text: 'user@example.com')

// Swipe up
input(action: 'swipe', direction: 'up')

// Launch app
app(action: 'launch', package: 'com.example.auroraapp')

// Read the UI tree (requires a supported backend)
ui(action: 'tree')

// Wait for element
ui(action: 'wait', text: 'Welcome', timeout: 5000)

// Prepare a Qt/QML app for inspection
aurora_ui_setup(packageName: 'ru.example.qmlapp')

// Take screenshot
screen(action: 'capture')

// Execute command on device
system(action: 'shell', command: 'ls /home')

// Emulate GPS position (emulator only)
sensor(action: 'location', platform: 'aurora', latitude: 59.9311, longitude: 30.3609, altitude: 10)

// Load and play a GPS route (emulator only)
sensor(action: 'track', platform: 'aurora', operation: 'load', file: './route.json', loop: true, speed: 2)
sensor(action: 'track', platform: 'aurora', operation: 'start')

// List devices
device(action: 'list', platform: 'aurora')
```

---

## UI Tree Backends

Aurora has no Android-style accessibility service. The plugin builds a
uiautomator-shaped tree from one of two backends and feeds it to the same
`parseUiHierarchy` path used by Android. When a backend is ready, these work
unchanged: `ui(tree|find|find_tap|tap_text|wait|assert_*)`,
`input(action: 'tap', text: ...)`, post-action hints, and
`screen(action: 'annotate')`.

### Backend selection

| Backend | App type | How it works | Requirements |
|---------|----------|--------------|--------------|
| **flutter** | Flutter apps (process maps `libflutter_engine`) | Reads the VM Service URL from the app journal, forwards the port over SSH, enables semantics, and dumps the semantics tree (labels, rects, flags/actions) | Debug or profile build with VM Service; app running |
| **qtium** | Other (Qt/QML) apps | Talks to the qtium-driver bridge on device port 8888 over an SSH tunnel; expects newline-delimited JSON and tries `app:dumpCurrentPage`, then `app:dumpTree` | Developer mode "Allow UI autotesting" (`qtium-bridge.service`), the qtium `LD_PRELOAD` hook loaded into the app, third-party sandboxed QML app |

The backend is chosen per running process: `libflutter_engine` in
`/proc/<pid>/maps` selects Flutter, otherwise Qt/QML is assumed. Tree output is
cached briefly and invalidated by taps, swipes, text input, and key presses.

Flutter needs no app changes: the tree comes from the engine's semantics
service. Flutter release AOT builds expose no VM Service and are
**unsupported**. Qtium only covers third-party sandboxed QML apps: system apps
do not load the hook, and Flutter apps never go through qtium.

### `aurora_ui_setup`

Explicit, agent-controlled preparation of the UI tree. It is idempotent and is
the only UI-tree operation that changes device state.

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `packageName` | auto | App to configure. Resolution order: this parameter, `AURORA_UI_APP` or the last app launched through MCP, then the only running app. |
| `restartApp` | `false` | Stop and relaunch the app so the qtium hook is loaded (also launches a named app that is not running). **Resets app state** — only set when the caller accepts that. |
| `enableAutoTest` | `true` | Enable developer-mode UI autotesting (start `qtium-bridge`) when it is not already active. |
| `deviceId` | active device | Optional audb device ID. |

Behavior:

1. Resolves the target app. If several apps are running and no `packageName` is
   given, it fails with `AMBIGUOUS_APP`.
2. **Flutter app:** returns `backend: "flutter"` immediately. No developer-mode
   changes, no restart — the VM Service is already there in debug/profile builds.
3. **Qt/QML app:** if the bridge is inactive and `enableAutoTest` is not `false`,
   runs `gdbus call --system --dest ru.omp.developermode --object-path /
   --method ru.omp.developermode.SetAutoTestUIEnabled true`, enabling developer
   mode first if that call fails, then runs `systemctl restart sailjaild` so the
   new permission set is visible without a reboot. It then waits up to 15 s for
   the bridge.
4. If the bridge is still inactive, returns `ok: false`,
   `code: "BRIDGE_INACTIVE"`.
5. Checks whether the qtium hook is loaded in the app process. If it is missing
   and `restartApp` is `false`, returns `ok: false`, `code:
   "APP_RESTART_REQUIRED"`, `needsAppRestart: true`. With `restartApp: true` it
   stops and relaunches the app (up to 15 s to come back).
6. Returns `ok`, `backend`, `bridgeActive`, `appHooked`, `appRestarted`,
   `needsAppRestart`, `message`, and on failure a `code`.

`aurora_ui_setup` requires root on the device (`audb shell --root`). Failures
surface as `AURORA_UI_SETUP_FAILED`, `BRIDGE_INACTIVE`, `APP_NOT_RUNNING`, or
`INVALID_ARGUMENT`.

### Auto-enable behavior

- Autotesting is auto-enabled **inside** `aurora_ui_setup` because
  `enableAutoTest` defaults to `true`. Pass `enableAutoTest: false` to inspect
  state without touching developer mode or `sailjaild`.
- Reading a tree (`ui(action: 'tree')` or any element lookup) never enables
  autotesting and never restarts the app. If the bridge or hook is missing, the
  call fails with `UI_TREE_SETUP_REQUIRED` and points at `aurora_ui_setup`.
- Launching an app with `app(action: 'launch')` makes it the active tree target;
  `app(action: 'stop')` clears it. Set `AURORA_UI_APP` to disambiguate when
  several apps are running.

### Coordinate space

- Both backends produce **device-space** bounds, the same space `audb` input
  uses. Flutter semantics rects are logical pixels and are scaled by the ratio
  of the `audb` screen geometry to the logical view. Qtium coordinates are
  usually screen pixels already; if a dump reports a larger logical space, it is
  scaled down to the screen.
- Coordinates shown by `ui(action: 'tree')`/`ui(action: 'find')` are device
  coordinates, matching the pixel space of `audb screenshot` (360×800 on the
  reference emulator). Element-based taps derive their target from those bounds
  directly.
- Raw `input(action: 'tap', x, y)` values use the same space, so tree
  coordinates can be passed back unchanged. Prefer `text`, `index`, or
  `resourceId` selectors: they survive layout and scale changes.

### Limitations

- **Qt/QML coverage is third-party sandboxed apps only.** The backend reads
  `app:dumpCurrentPage` (JSON) and falls back to `app:dumpTree` (base64 + zlib).
  If the bridge does not know the app (`unknown_app`), the hook was not loaded
  at launch: call `aurora_ui_setup` with `restartApp: true`. System apps and
  Flutter apps are not covered by qtium.
- **Flutter release builds are unsupported.** Only debug/profile builds expose
  the VM Service; release AOT builds fail with `VM_SERVICE_NOT_DISCOVERED`.
- **The Flutter VM Service URL is announced once, in the journal.** If the app
  has been running long enough for that line to rotate away, discovery fails
  with `VM_SERVICE_TOKEN_LOST` (the port is still reported). Relaunch the app to
  re-announce it; this resets app state.
- **Setup is runtime-only.** The tree exists while the app is running with the
  hook or VM Service active; restarting the app or leaving it in the background
  can invalidate it.
- **Only the target app is described.** System UI and other processes are not
  part of the tree.
- **Two coordinate spaces exist.** Element selectors are safe; raw coordinates
  depend on the last screenshot. Element-based taps are preferred.
- `performance`, `visual`, and `accessibility` remain unavailable on Aurora.

---

## Example Workflows

### Workflow 1: Automate Aurora Flutter app login + verification

```
// 1. List available Aurora devices
device(action: 'list', platform: 'aurora')
→ { devices: [{ id: 'aurora-emulator-1', name: 'Aurora Emulator' }] }

// 2. Set target to Aurora
device(action: 'set_target', target: 'aurora')

// 3. Launch the app (use a debug/profile build for Flutter UI trees)
app(action: 'launch', package: 'com.example.myauroraapp')

// 4. Confirm the backend. Flutter debug apps need no setup; QML apps may
//    return APP_RESTART_REQUIRED — see Workflow 5.
aurora_ui_setup(packageName: 'com.example.myauroraapp')
→ { ok: true, backend: 'flutter' }

// 5. Wait for login form
ui(action: 'wait', text: 'Login', timeout: 5000)

// 6. Fill email
input(action: 'tap', text: 'Email')
input(action: 'text', text: 'aurora_user@example.com')

// 7. Fill password
input(action: 'tap', text: 'Password')
input(action: 'text', text: 'AuroraPass123')

// 8. Tap login
input(action: 'tap', text: 'Sign In')

// 9. Verify success
ui(action: 'wait', text: 'Dashboard', timeout: 3000)
screen(action: 'capture')
```

### Workflow 2: Cross-platform testing (Aurora + Android)

```
// 1. Test on Android first
device(action: 'set_target', target: 'android')
app(action: 'launch', package: 'com.example.myapp')
ui(action: 'wait', text: 'Welcome', timeout: 3000)
screen(action: 'capture', preset: 'low')

// 2. Switch to Aurora platform
device(action: 'set_target', target: 'aurora')

// 3. Run the same flow on Aurora
app(action: 'launch', package: 'com.example.myapp')
aurora_ui_setup(packageName: 'com.example.myapp')
ui(action: 'wait', text: 'Welcome', timeout: 3000)
screen(action: 'capture', preset: 'low')

// 4. Compare the two PNGs outside MCP.
// The visual module is NOT available on Aurora, so there is no
// visual(action:'baseline'/'compare') step here.
```

### Workflow 3: Shell commands + log inspection

```
// 1. Set Aurora as target
device(action: 'set_target', target: 'aurora')

// 2. Execute shell command to get device info
system(action: 'shell', command: 'uname -a')
→ { output: 'Aurora Linux ...' }

// 3. Launch app and prepare the tree for element-based actions
app(action: 'launch', package: 'com.example.debugapp')
aurora_ui_setup(packageName: 'com.example.debugapp')

// 4. Perform operation through the UI tree
input(action: 'tap', text: 'Process Data')

// 5. Check logs for errors
system(action: 'logs', filter: 'Exception')
→ { logs: 'Output from logcat-equivalent' }

// 6. Verify no crashes
system(action: 'shell', command: 'ps aux | grep myapp')
→ Should show process still running
```

### Workflow 4: Multi-screen navigation on Aurora

```
// 1. Launch app and prepare the tree
app(action: 'launch', package: 'com.example.navigationapp')
aurora_ui_setup(packageName: 'com.example.navigationapp')

// 2. Navigate through screens
ui(action: 'wait', text: 'Home', timeout: 3000)
input(action: 'tap', text: 'Profile')

ui(action: 'wait', text: 'User Profile', timeout: 3000)
input(action: 'tap', text: 'Settings')

ui(action: 'wait', text: 'Settings', timeout: 3000)
input(action: 'tap', text: 'About')

ui(action: 'wait', text: 'About App', timeout: 3000)

// 3. Verify final screen
screen(action: 'capture')

// 4. Go back
input(action: 'key', key: 'BACK')
ui(action: 'wait', text: 'Settings', timeout: 2000)
```

### Workflow 5: Prepare a Qt/QML app for UI inspection

```
// 1. Launch a third-party sandboxed QML app
app(action: 'launch', package: 'ru.example.qmlapp')

// 2. Check whether autotesting and the hook are ready
aurora_ui_setup(packageName: 'ru.example.qmlapp')
→ { ok: false, code: 'APP_RESTART_REQUIRED', needsAppRestart: true }

// 3. Accept the state reset and restart to load the qtium hook
aurora_ui_setup(packageName: 'ru.example.qmlapp', restartApp: true)
→ { ok: true, backend: 'qtium', bridgeActive: true, appHooked: true, appRestarted: true }

// 4. Inspect and interact (setup also selects the app for later ui calls)
ui(action: 'tree', format: 'semantic')
input(action: 'tap', text: 'Continue')
```

---

## Troubleshooting

| Problem | Cause | Solution |
|---------|-------|----------|
| "Aurora SDK not found" | `audb` not installed or not in PATH | Install Aurora Flutter SDK; add to PATH |
| "No devices attached" | No emulator running or device not connected | Start Aurora emulator; check USB connection on physical device |
| "Element not found" | Tree backend unavailable or text doesn't match | Confirm `ui(action: 'tree')` returns elements; call `aurora_ui_setup` for QML apps |
| "UI_TREE_SETUP_REQUIRED" | qtium bridge inactive or hook not loaded | Call `aurora_ui_setup`; repeat with `restartApp: true` if it returns `APP_RESTART_REQUIRED` |
| "VM_SERVICE_NOT_DISCOVERED" | Flutter release build, app not running, or log line rotated away | Use a debug/profile build; keep the app running and relaunch to refresh the journal |
| "VM_SERVICE_TOKEN_LOST" | The app has a VM Service socket, but its auth token left the journal | Relaunch the app to re-announce the service (resets app state) |
| "APP_NOT_RUNNING" / "AMBIGUOUS_APP" | Target app cannot be resolved | Launch the app, pass `packageName`, or set `AURORA_UI_APP` |
| "QTIUM_TIMEOUT" / "QTIUM_DUMP_UNAVAILABLE" | The bridge stopped responding or the hook is missing | Re-run `aurora_ui_setup`; if it reports `APP_RESTART_REQUIRED`, retry with `restartApp: true` |
| "AURORA_UI_SETUP_FAILED" / "BRIDGE_INACTIVE" | No root access or developer mode cannot be enabled | Verify `audb shell --root` works and developer mode is available on the device |
| "App not found" | Package name incorrect or app not installed | Verify package name; install app first with `app(action: 'install', ...)` |
| "Shell command fails" | Command not available or permission denied | Check command syntax; some commands may require elevated permissions |

---

## Related Documentation

- [Modules & Tools Overview](./README.md) — Architecture, profiles, module visibility
- [Android Platform](./plugin-android.md) — Similar features on Android
- [Built-in Tools Reference](./built-in-tools.md) — Full action catalog for all modules
- [Aurora Linux Project](https://gitlab.com/auroraos/) — Aurora OS official resources
