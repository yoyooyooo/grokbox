import { expect, test } from "bun:test";
import { canonicalJson, sha256Text } from "../src/hash.ts";
import { ContextFailure, contextManualApprovalKey, parseContextManualApproval, parseContextBudget } from "../src/compaction.ts";
import { contextManualApprovalRevision, ContextFailure as ExecutionFailure } from "../src/contract.ts";
import { captureContextPolicy, contextBudget } from "../src/config.ts";
const agent = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const approval = { scopeId: "a".repeat(64), hostGeneration: "b".repeat(64), selectionRevision: "c".repeat(64), policyRevision: "d".repeat(64) };

test("one pure approval contract has identical canonical bytes and SHA across browser and native consumers", async () => {
  expect(ContextFailure).toBe(ExecutionFailure);
  const reordered = Object.fromEntries(Object.entries(approval).reverse()) as typeof approval;
  const bytes = contextManualApprovalKey(agent, reordered);
  expect(bytes).toBe(canonicalJson(["managed-compaction-v1", agent, approval]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bytes)));
  expect(Array.from(digest, b => b.toString(16).padStart(2, "0")).join("")).toBe(contextManualApprovalRevision(agent, approval));
  expect(sha256Text(bytes)).toBe(contextManualApprovalRevision(agent, approval));
});

test("pure approval and budget reject accessors and coercion without invoking untrusted code", () => {
  let invoked = 0;
  expect(() => parseContextManualApproval({ ...approval, get scopeId() { invoked++; return approval.scopeId; } })).toThrow();
  expect(() => parseContextManualApproval({ ...approval, [Symbol("extra")]: true })).toThrow();
  const budget = contextBudget(captureContextPolicy(undefined, "owned/model", agent), 500000);
  expect(parseContextBudget(budget)).toEqual(budget);
  expect(parseContextBudget(budget)).not.toBe(budget);
  expect(() => parseContextBudget({ ...budget, mode: { toString() { invoked++; return "auto"; } } })).toThrow();
  expect(() => parseContextBudget({ ...budget, get windowTokens() { invoked++; return budget.windowTokens; } })).toThrow();
  expect(invoked).toBe(0);
});
