# Release v4.5.0-fork.1 — 2026-11-24

Status: **prepared locally, not published**. No push, tag not pushed.

## Included

- Aurora UI tree with two backends:
  - Flutter debug/profile through the VM Service semantics tree (labels, rects,
    flags/actions, logical→device scaling).
  - Qt/QML through the qtium bridge (`app:dumpCurrentPage`, `app:dumpTree`),
    root-window scaling, viewport clipping, `acceptedButtons` click targets.
- `aurora_ui_setup` tool: enables developer-mode UI autotesting, refreshes
  `sailjaild`, raises the target app, restarts it only with `restartApp: true`.
- Core integration: `ui(tree|find|find_tap|tap_text|wait|assert_*)`,
  `input tap(text)`, hints, `screen annotate`, XML entity decoding, Aurora cache
  keys.
- `app(action:'launch')` raises an already-running app through lipstick.
- `system(action:'logs')` forwards `since`/`grep`/`priority` on Aurora;
  `performance(action:'crashes')` uses `audb crash list`.
- `screen(action:'capture', saveTo)` writes a file instead of inline base64.
- Rootless Flutter detection (VM Service journal line when `/proc/<pid>/maps`
  is unreadable).
- Hardening from the code review: session reuse across input actions, exact
  `systemctl is-active` matching, audb stderr propagation, ssh spawn errors,
  qtium framing/tunnel retry/boolean coercion, cache invalidation.

## Verification

| Check | Result |
|-------|--------|
| `npm run build` | exit 0 |
| `npm test` | 91 files passed, 1662 tests; E2E suite skipped by default |
| `AURORA_E2E=1` (Flutter `ru.lifeteo.veredin_mobile`) | 5/5 passed |
| `AURORA_E2E=1` (QML `ru.lifeteo.sasflix`) | 5/5 passed |
| `node dist/index.js --version` | `4.5.0-fork.1`, exit 0 |
| `node dist/index.js --help` | exit 0 |
| `import("./dist/browser/client.js")` | ok |
| `cd cli && cargo build --release` | exit 0 |
| `cargo test --lib` | 200 passed |
| `cargo test --test setup_grok/repl_observability/repl_live_tui/harmony_cli/performance_cli` | all passed |
| `npm pack` + clean-dir install | version matches, bundled `@mcp-devices/plugin-api` present |

## Channels

Not touched. Publishing requires the fork's own credentials and explicit
confirmation; the `release.yml` pipeline treats `-fork.N` as a pre-release
(GitHub pre-release, npm dist-tag `fork`, Homebrew skipped).

## Known limitations

- Flutter release AOT builds have no VM Service and are unsupported.
- A long-running Flutter app can outlive its VM Service journal line; a live
  session is reused, otherwise `VM_SERVICE_TOKEN_LOST` asks for a relaunch.
- Qt/QML coverage is limited to third-party sandboxed apps.
- `screen(action:'capture', monitorIndex)` is still a no-op (pre-existing; the
  buffer is captured without monitor options).

## Remaining before publishing

- Stage 0 of `.claude/profiles/release.md` (`gh issue list`) — `gh` is not
  installed in this environment.
- Explicit confirmation for `git push` and publishing.
