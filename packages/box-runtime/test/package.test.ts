import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import cliPackage from "../../cli/package.json" with { type: "json" };
import runtimePackage from "../package.json" with { type: "json" };
import rootPackage from "../../../package.json" with { type: "json" };

describe("workspace packages", () => {
  test("box-runtime is unpublished and isolated from the published grokbox name", () => {
    expect(runtimePackage.name).toBe("@grokbox/box-runtime");
    expect(runtimePackage.private).toBe(true);
    expect(cliPackage.name).toBe("@grokbox/cli");
    expect(cliPackage.private).toBe(true);
    expect(rootPackage.name).toBe("grokbox");
    expect("private" in rootPackage).toBe(false);
    expect(rootPackage.workspaces).toEqual(["packages/*"]);
    expect(rootPackage.dependencies).toEqual({});
    expect(cliPackage.dependencies).toEqual({ "@grokbox/box-runtime": "workspace:*" });
  });

  test("runtime package has no daemon or profile entry", () => {
    expect(Object.keys(runtimePackage).includes("bin")).toBe(false);
    expect(join(dirname(import.meta.dir), "src", "index.ts").replaceAll("\\", "/")).toMatch(
      /packages\/box-runtime\/src\/index\.ts$/,
    );
  });
});
