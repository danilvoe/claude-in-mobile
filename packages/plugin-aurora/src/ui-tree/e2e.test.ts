/**
 * Opt-in end-to-end test for the Aurora UI tree.
 *
 * `npm test` must not depend on an emulator, so the whole suite is skipped
 * unless `AURORA_E2E=1`. A second skip guard keeps the suite honest when the
 * target app is not already running: the test never launches, stops or
 * restarts anything, and it never taps or swipes. The only side effect is
 * `setup({ restartApp: false })`, which (for QML apps) raises the window and
 * may enable developer-mode autotesting — the same thing the
 * `aurora_ui_setup` tool does.
 *
 * Run against a live device:
 *   AURORA_E2E=1 AURORA_E2E_APP=ru.lifeteo.veredin_mobile \
 *     npx vitest run packages/plugin-aurora/src/ui-tree/e2e.test.ts
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parseUiHierarchy, type UiElement } from "mcp-devices/ui-tree/ui-parser";

import { auroraClient } from "../client.js";
import { AuroraUiTreeProvider, type UiTreeSetupResult } from "./provider.js";

const enabled = process.env.AURORA_E2E === "1";
const appPackage = process.env.AURORA_E2E_APP ?? "ru.lifeteo.veredin_mobile";

/** Read-only check: the suite only targets apps that are already up. */
function isTargetRunning(): boolean {
  try {
    return auroraClient.listRunningApps().some((app) => app.package === appPackage);
  } catch {
    return false;
  }
}

// Resolved at collection time (skipIf needs a boolean). The audb probe only
// runs when the e2e suite is actually requested, so the default `npm test`
// stays hermetic.
const appRunning = enabled && isTargetRunning();

describe.skipIf(!enabled)("Aurora UI tree end-to-end", () => {
  describe.skipIf(!appRunning)(
    `read-only tree dump for ${appPackage} (skipped unless it is already running)`,
    () => {
      let provider: AuroraUiTreeProvider;
      let setupResult: UiTreeSetupResult;
      let elements: UiElement[] = [];

      beforeAll(async () => {
        provider = new AuroraUiTreeProvider(auroraClient);
        // restartApp: false — never relaunch the app under test.
        setupResult = await provider.setup({ packageName: appPackage, restartApp: false });
      }, 60_000);

      afterAll(() => {
        provider?.close();
      });

      it("reports a usable backend without restarting the app", () => {
        expect(setupResult.packageName).toBe(appPackage);
        expect(setupResult.backend, setupResult.message).toMatch(/^(flutter|qtium)$/);
        expect(setupResult.ok, setupResult.message).toBe(true);
        expect(setupResult.appRestarted).toBeFalsy();
      }, 60_000);

      it("dumps XML that parses into at least three elements", async () => {
        // The first dump may need to discover the VM Service or start the
        // qtium bridge, hence the generous timeout.
        const xml = await provider.getHierarchy({ fresh: true, packageName: appPackage });
        expect(xml.length).toBeGreaterThan(0);

        elements = parseUiHierarchy(xml);
        expect(elements.length).toBeGreaterThanOrEqual(3);
      }, 60_000);

      it("keeps every element inside the screenshot geometry", () => {
        expect(elements.length, "the hierarchy dump must have succeeded first")
          .toBeGreaterThan(0);

        const geometry = auroraClient.getScreenshotGeometry();
        expect(geometry.width).toBeGreaterThan(0);
        expect(geometry.height).toBeGreaterThan(0);

        const violations = elements.filter((element) => {
          const { x1, y1, x2, y2 } = element.bounds;
          const inside = x1 >= 0
            && y1 >= 0
            && x2 <= geometry.width
            && y2 <= geometry.height
            && x2 > x1
            && y2 > y1;
          const centered = element.centerX >= x1
            && element.centerX <= x2
            && element.centerY >= y1
            && element.centerY <= y2;
          return !inside || !centered;
        });

        expect(
          violations.map((element) => `${element.className} bounds=${JSON.stringify(element.bounds)}`),
          `screen ${geometry.width}x${geometry.height}`,
        ).toEqual([]);
      }, 60_000);

      it("exposes at least one labelled or clickable element", () => {
        expect(elements.length, "the hierarchy dump must have succeeded first")
          .toBeGreaterThan(0);
        expect(elements.some((element) => element.text.trim().length > 0 || element.clickable))
          .toBe(true);
      }, 60_000);

      it("serves the second read from the cache without fresh", async () => {
        const fresh = await provider.getHierarchy({ fresh: true, packageName: appPackage });
        const cached = await provider.getHierarchy({ packageName: appPackage });

        expect(cached).toBe(fresh);
        expect(cached.length).toBeGreaterThan(0);
      }, 60_000);
    },
  );
});
