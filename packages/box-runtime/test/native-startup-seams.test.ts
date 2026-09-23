import { expect, test } from "bun:test";
import { readNativeSource } from "./native-host-source.ts";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { sha256Text } from "@grokbox/runtime-kernel/hash";
import { HOST_RECIPE } from "../src/internal/host/source-recipes.ts";
import { NATIVE_CURRENT_STATE_SYMBOL } from "../src/internal/host/native-current-state-owner.ts";
import { CONT_NATIVE_PAIR, nativeContinuityCode, nativeContinuityEnabled } from "./native-continuity-code.ts";

const nativeTest = test.skipIf(!nativeContinuityEnabled());
const agentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", messageId = "grokbox-startup:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
nativeTest("original resume explicitly has no-turn no-op; startup selects new-turn action rather than disguising that no-op", async () => {
  const source = readNativeSource("source").toString("utf8");
  expect(sha256Text(source)).toBe(CONT_NATIVE_PAIR.host);
  const classAt = source.indexOf("var ResumeActionHandler = class"), begin = source.indexOf("  async setupResumeStep(", classAt), end = source.indexOf("  async handleSingleStep(", begin);
  expect(begin).toBeGreaterThan(classAt); expect(end - begin).toBeLessThan(8192);
  // Only the original no-turn decision is evaluated here. Do not run an async
  // VM method through Bun's cross-realm promise scheduling or call this a full
  // original-handler execution; full startup remains in the explicit live lane.
  const decision = source.slice(begin,end).match(/    if \(stateHandler\.turns\.length === 0\) \{\s+return \{ noTurns: true \};\s+\}/)?.[0];
  expect(decision).toBeDefined();
  const result = runInNewContext(`(function(){${decision}})()`, { stateHandler: { turns: [] } }, { timeout: 1000 });
  expect(result).toEqual({ noTurns: true });
  const slice = HOST_RECIPE.currentState.find(s => s.id === "continuity-native-startup-action")!;
  // Evaluate the exact new branch with owned action constructors and the actual
  // native UserMessage codec. This is an action-shape proof, not a model call.
  const code = slice.replacement.replace("        } =", "const value =") + ' action: "ordinary-resume" } : { action: "ordinary-input" }; value;';
  const constructor = class { constructor(fields: object) { Object.assign(this, fields); } };
  const context: any = { __grokbox_startup: true, resumeTurn: false, actionOnly: false, UserMessage: nativeContinuityCode().UserMessage,
    ConversationAction: constructor, UserMessageAction: constructor, host: { getConversationId: () => agentId } };
  context[Symbol.for(NATIVE_CURRENT_STATE_SYMBOL)] = { startupMessageId: () => messageId };
  const action = runInNewContext(code, context, { timeout: 1000 });
  expect(action.action.action.case).toBe("userMessageAction");
  expect(action.action.action.value.userMessage).toMatchObject({ text: "", messageId, isSimulatedMsg: true });
  expect(action.action.action.value.sendToInteractionListener).toBe(false);
});

nativeTest("qualified native turn writer omits the prompt only for the trusted program carrier, not ordinary user messages", async () => {
  const source = readNativeSource("source").toString("utf8"); expect(sha256Text(source)).toBe(CONT_NATIVE_PAIR.host);
  const patch = HOST_RECIPE.currentState.find(s => s.id === "continuity-native-startup-no-user-prompt")!;
  const begin = source.indexOf(patch.find, source.indexOf(patch.startAnchor));
  const end = source.indexOf(patch.endAnchor, begin);
  expect(begin).toBeGreaterThan(0); expect(end - begin).toBeLessThan(1024);
  const original = source.slice(begin, end), updated = original.replace(patch.find, patch.replacement);
  for (const trusted of [false, true]) {
    const appended: unknown[] = [];
    const context: any = { SimulatedMsgReason: { BACKGROUND_TASK_COMPLETION: 3 },
      userMessage2: new (nativeContinuityCode().UserMessage)({ text: "", messageId, isSimulatedMsg: true }),
      config2: { conversationGroupId: agentId }, redactedMessage: { role: "user", content: "MUST_NOT_APPEND_FOR_STARTUP" } };
    context[Symbol.for(NATIVE_CURRENT_STATE_SYMBOL)] = { isStartupUserMessage: () => trusted };
    const run = runInNewContext(`(function(){${updated}})`, context, { timeout: 1000 });
    run.call({ rootPromptBuilder: { appendMessages: (v: unknown) => appended.push(v) } });
    expect(appended.length).toBe(trusted ? 0 : 1);
  }
});
