import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { LIVE_HOST_BUNDLE, LIVE_SLICE_PATCHES } from "../src/internal/host/live-slices.ts";
import { HOST_RECEIVER_MODEL_SYMBOL } from "../src/internal/host/receiver-model.node.ts";
import { profileFromSource, applyPatchProfile } from "../src/internal/host/profile.ts";
import { nativeReceiverModelRevision } from "@grokbox/runtime-kernel/observation";

// A separate explicit qualification pin; do not silently renew unrelated native
// probes or make this private bundle a public build/test dependency.
const SOURCE_SHA = "e7031f773bf035d02952d8b76dc2d2be6cea7167305116cf3e9b05d2c067b06e";
const nativeTest = test.skipIf(process.env.GROKBOX_TEST_NATIVE_HOST !== "1");
nativeTest("source-pinned automation preview follows original native model selection without starting a session or marking experiment application", () => {
  const source = readFileSync(LIVE_HOST_BUNDLE, "utf8");
  expect(createHash("sha256").update(source).digest("hex")).toBe(SOURCE_SHA);
  const profile = profileFromSource(source, LIVE_SLICE_PATCHES, "receiver-native-preview");
  const patched = applyPatchProfile(source, profile); expect(patched.ok, patched.ok ? undefined : patched.code).toBe(true); if (!patched.ok) throw Error("qualified_slice_failed");
  const needed = new Set(["createHostInference", "createCursorSandInference", "resolveSandRequestedModel", "selectSandExperimentTurnModel",
    "selectSandModelExperimentModel", "createSandRequestedModelFromSelection", "createSandDefaultRequestedModel", "createSandSubagentRequestedModel"]);
  const ast = ts.createSourceFile("native.cjs", patched.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), functions = new Map<string, string>();
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && needed.has(node.name.text)) {
      expect(functions.has(node.name.text)).toBe(false); functions.set(node.name.text, node.getText(ast));
    }
    ts.forEachChild(node, visit);
  }
  visit(ast); expect(functions.size).toBe(needed.size);
  class RequestedModel {
    modelId = ""; maxMode = false; parameters: unknown[] = []; credentials = { case: undefined }; builtInModel = false; isVariantStringRepresentation = false;
    constructor(value: object) { Object.assign(this, value); }
  }
  class Parameter { constructor(value: object) { Object.assign(this, value); } }
  const selection = (modelId: string) => ({ modelId, maxMode: false, parameters: [{ id: "effort", value: "medium" }] });
  for (const state of [undefined, { active: true, arm: "control" }, { active: true, arm: "treatment" }]) {
    for (const envOverride of [undefined, "env-override"]) {
      let getter: (() => { mockConfigured: boolean; requestedModel?: unknown }) | undefined;
      let sessions = 0, applied = 0, authCalls = 0;
      const capture = { capture: (read: typeof getter) => { getter = read; } };
      const scope: Record<string | symbol, unknown> = { RequestedModel, RequestedModel_ModelParameterValue: Parameter,
        SAND_DEFAULT_MODEL_ID: "fallback", SAND_DEFAULT_MODEL_SELECTION: selection("fallback"),
        SAND_MODEL_EXPERIMENT_OPUS_MEDIUM_SELECTION: selection("control"), SAND_AUTOMATION_REQUEST_SOURCE: "automation",
        sandComputerUseModelSchema: { safeParse: () => ({ success: false }) }, sandBrowserUseModelSchema: { safeParse: () => ({ success: false }) },
        createSandAttachedMediaUrlProvider: () => ({}), resolveComputerUseModelSelection: (input: { storedModel: unknown }) => input.storedModel,
        createCursorInferencePromptSession: (input: { requestedModel: unknown }) => { sessions++; return { model: input.requestedModel }; },
      };
      scope[Symbol.for(HOST_RECEIVER_MODEL_SYMBOL)] = capture;
      const build = runInNewContext(`${[...functions.values()].join("\n")}\ncreateHostInference`, scope,
        { timeout: 2000, contextCodeGeneration: { strings: false, wasm: false } });
      const inference = build({ environment: { backend: {}, agentModelOverride: envOverride },
        settings: { getAgentDefaultModel: () => selection("stored"), getComputerUseModel: () => undefined },
        experiments: { getSandModelExperimentState: () => state, getConfiguredDefaultModel: () => selection("chat-treatment"),
          getConfiguredAutomationsModel: () => selection("automation-treatment"), hasHydratedStatsigUserId: () => true,
          getComputerUseModelOverride: () => undefined, getBrowserUseModelOverride: () => undefined, checkFeatureGate: () => false },
        auth: { getAccessToken: () => { authCalls++; throw Error("no-auth"); } }, onModelExperimentApplied: () => { applied++; } });
      expect(typeof getter).toBe("function"); const preview = getter!();
      expect(preview.mockConfigured).toBe(false); expect(sessions).toBe(0); expect(applied).toBe(0); expect(authCalls).toBe(0);
      const actual = inference.createSession(undefined, { requestSource: "automation" });
      expect(nativeReceiverModelRevision(preview.requestedModel)).not.toBeNull();
      expect(nativeReceiverModelRevision(actual.model)).toBe(nativeReceiverModelRevision(preview.requestedModel));
      expect(sessions).toBe(1); expect(applied).toBe(1); expect(authCalls).toBe(0);
      if (!envOverride && state?.arm === "treatment") {
        const chat = inference.createSession(undefined, { requestSource: "user" });
        expect(nativeReceiverModelRevision(chat.model)).not.toBe(nativeReceiverModelRevision(preview.requestedModel));
      }
    }
  }
}, 30000);
