import { describe, expect, it } from "vitest";
import { FlutterTestController } from "./test.js";
import { buildFlutterTools } from "./tools.js";

describe("Flutter MCP tools", () => {
  it("exposes doctor, devices, test and permissions", () => {
    const tools = buildFlutterTools(new FlutterTestController());
    expect(tools.map((tool) => tool.name)).toEqual([
      "flutter_doctor",
      "flutter_devices",
      "flutter_test",
      "flutter_permissions",
    ]);
  });

  it("declares permissionPolicy on flutter_test and permissions fields on flutter_permissions", () => {
    const tools = buildFlutterTools(new FlutterTestController());
    const testTool = tools.find((tool) => tool.name === "flutter_test");
    const testSchema = testTool?.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(testSchema.properties).toHaveProperty("permissionPolicy");
    expect(testSchema.properties).not.toHaveProperty("freeArgs");

    const permissionTool = tools.find((tool) => tool.name === "flutter_permissions");
    const permissionSchema = permissionTool?.inputSchema as {
      properties?: Record<string, unknown>;
    };
    expect(permissionSchema.properties).toHaveProperty("applicationId");
    expect(permissionSchema.properties).toHaveProperty("action");
    expect(permissionSchema.properties).toHaveProperty("permissions");
  });
});
