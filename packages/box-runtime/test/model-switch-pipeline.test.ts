import { test } from "bun:test";
import { exerciseModelSwitchPipeline } from "./model-switch-pipeline-fixture.ts";
test("per-Bot official/A/B/official/A selection preserves active TURNs, Host state and the other Bot", () => exerciseModelSwitchPipeline(), 15_000);
