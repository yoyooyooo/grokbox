import { expect, test } from "bun:test";
import {
  composeAgentTitle,
  formatAgentTitle,
  labelOwnerFromState,
  parseAgentTitle,
  TITLE_FENCE,
  chunkOwnershipTargets,
  OWNERSHIP_MAX_TARGETS,
} from "@grokbox/runtime-kernel/contract";
import { assignedModelTokens, parseModelsFile } from "@grokbox/runtime-kernel/selection";

test("parse splits user text from a valid trailer; last fence wins", () => {
  expect(parseAgentTitle("coding | owner=box,m=g46")).toMatchObject({
    user: "coding",
    showing: true,
    fields: { owner: "box", m: "g46", extra: [] },
  });
  expect(parseAgentTitle("a | b | owner=box")).toMatchObject({ user: "a | b", showing: true, fields: { owner: "box" } });
  expect(parseAgentTitle("coding | not-kv")).toMatchObject({ user: "coding | not-kv", showing: false });
  expect(parseAgentTitle("owner=box,m=g46")).toMatchObject({ user: "", showing: true, fields: { owner: "box", m: "g46" } });
  expect(parseAgentTitle("coding")).toMatchObject({ user: "coding", showing: false });
  expect(parseAgentTitle("box")).toMatchObject({ user: "", showing: true, fields: { owner: "box" } });
});

test("sloppy fences parse as showing and show/hide normalize to TITLE_FENCE", () => {
  for (const raw of ["abc| owner=box", "abc |owner=box", "abc|owner=box"]) {
    expect(parseAgentTitle(raw)).toMatchObject({ user: "abc", showing: true, fields: { owner: "box" } });
    expect(composeAgentTitle(raw, { type: "show", owner: "box" }).title).toBe(`abc${TITLE_FENCE}owner=box`);
    expect(composeAgentTitle(raw, { type: "hide" }).title).toBe("abc");
  }
  expect(composeAgentTitle("abc| owner=box | owner=box", { type: "show", owner: "box" }).title)
    .toBe(`abc${TITLE_FENCE}owner=box`);
});

test("show paints latest owner/m in front of user text; hide strips the trailer", () => {
  expect(composeAgentTitle("coding", { type: "show", owner: "box", m: "g46" }).title).toBe(`coding${TITLE_FENCE}owner=box,m=g46`);
  expect(composeAgentTitle("coding | owner=box", { type: "show", owner: "box", m: "g46" }).title).toBe(`coding${TITLE_FENCE}owner=box,m=g46`);
  expect(composeAgentTitle("", { type: "show", owner: "box" }).title).toBe("owner=box");
  expect(composeAgentTitle("coding | owner=box,m=g46", { type: "hide" })).toEqual({
    title: "coding",
    changed: true,
    showing: false,
  });
});

test("sync refreshes showing titles and skips hidden; set-user coexists when showing", () => {
  expect(composeAgentTitle("coding", { type: "sync", owner: "box", m: "g46" }).skipped).toBe("hidden");
  expect(composeAgentTitle("coding | owner=box", { type: "sync", owner: "box", m: "g46" }).title).toBe(`coding${TITLE_FENCE}owner=box,m=g46`);
  expect(composeAgentTitle("coding | owner=box,m=old", { type: "set-user", user: "new", owner: "box", m: "g46" }).title)
    .toBe(`new${TITLE_FENCE}owner=box,m=g46`);
  expect(composeAgentTitle("coding", { type: "set-user", user: "new", owner: "box", m: "g46" }).title).toBe("new");
  expect(composeAgentTitle("coding | owner=box,x=keep", { type: "show", owner: "temporal", m: null }).title)
    .toBe(`coding${TITLE_FENCE}owner=temporal,x=keep`);
});

test("ownership class maps to Label owner without treating unconfirmed as temporal", () => {
  expect(labelOwnerFromState("confirmed_box")).toBe("box");
  expect(labelOwnerFromState("unconfirmed")).toBe("leave");
});

test("assigned tokens prefer alias then short model id", () => {
  const file = parseModelsFile({
    version: 1,
    models: {
      "openai-responses/grok-4.6": {
        provider: "openai-responses",
        model: "grok-4.6",
        endpoint: "https://example.invalid/v1",
        apiKeyRef: "env:GROKBOX_KEY",
        alias: "g46",
      },
      "openai-chat/other": {
        provider: "openai-chat",
        model: "other-model",
        endpoint: "https://example.invalid/v1",
        apiKeyRef: "env:GROKBOX_KEY",
      },
    },
    assignments: {
      main: null,
      agents: {
        "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa": "openai-responses/grok-4.6",
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb": "openai-chat/other",
      },
    },
  });
  const tokens = assignedModelTokens(file);
  expect(tokens.get("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")).toBe("g46");
  expect(tokens.get("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")).toBe("other-model");
  expect(formatAgentTitle("coding", { owner: "box", m: "g46", extra: [] })).toBe("coding | owner=box,m=g46");
});

test("ownership target chunks stay within the Server List cap", () => {
  const ids = Array.from({ length: OWNERSHIP_MAX_TARGETS + 2 }, (_, i) => `id-${i}`);
  const chunks = chunkOwnershipTargets([...ids, ids[0]!]);
  expect(chunks).toHaveLength(2);
  expect(chunks[1]).toEqual(["id-32", "id-33"]);
});
