import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const source = (path: string) => readFileSync(join(repoRoot, path), "utf8");

describe("shared configuration writer import boundaries", () => {
  // Structural ownership checks complement configuration-write/model-management
  // behavior tests; source strings do not prove durability or concurrent safety.
  test("model publication uses the shared protected publisher and process lease", () => {
    const writer = source("packages/box-runtime/src/internal/io/configuration.node.ts");
    expect(writer).toContain("acquireConfigurationLease");
    expect(writer).toContain("publishConfigFile(modelsPath(root), persisted)");
    expect(writer).toContain("expectedRevision");
    expect(writer).not.toContain("writeJsonAtomic");
    const operations = source("packages/box-runtime/src/internal/io/model-management.node.ts");
    expect(operations).toContain("store.saveModels(next, persistedModelsRevision(current.models))");
    expect(operations).not.toContain("publishConfigFile(modelsPath");
  });

  test("CLI model selection has no direct file writer or implicit Gateway path", () => {
    const cli = source("packages/cli/src/commands/runtime.ts");
    expect(cli).not.toContain("changeRuntimeModel");
    expect(cli).toContain("saveRuntimeDesired");
    expect(cli).not.toMatch(/runtime\.saveModels\(/);
    expect(cli).not.toMatch(/runtime\.saveDesired\(/);
    const management = source("packages/cli/src/commands/management-api.ts");
    expect(management).toContain("client.changeModels");
    expect(management).not.toContain("GatewayClient");
    expect(management).not.toContain("saveModels");
  });
});
