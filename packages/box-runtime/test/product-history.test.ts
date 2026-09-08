import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  mergeLivePromptWithProductHistory,
  productTurnsFromStoreEntries,
  readProductHistory,
} from "../src/product-history.ts";

describe("product history from this bot's store", () => {
  test("reads user messages and send-message bubbles; skips pings and 我查一下", () => {
    const rows = [
      { entry: JSON.stringify({ kind: "message", role: "user", content: "你来辅助我了解grok bot本身。" }) },
      { entry: JSON.stringify({ kind: "send-message", message: { type: "text", content: "行。我就是 grok bot。" } }) },
      { entry: JSON.stringify({ kind: "message", role: "user", content: "https://x.com/mylifcc/status/1 看一下这条推文。" }) },
      { entry: JSON.stringify({ kind: "send-message", message: { type: "text", content: "这是 @mylifcc 今早那条 thread。" } }) },
      { entry: JSON.stringify({ kind: "message", role: "user", content: "ping — reply with exactly: pong" }) },
      { entry: JSON.stringify({ kind: "send-message", message: { type: "text", content: "我查一下之前的记录。" } }) },
      { entry: JSON.stringify({ kind: "spend-initiation" }) },
    ];
    const turns = productTurnsFromStoreEntries(rows);
    expect(turns).toEqual([
      { role: "user", content: "你来辅助我了解grok bot本身。" },
      { role: "assistant", content: "行。我就是 grok bot。" },
      { role: "user", content: "https://x.com/mylifcc/status/1 看一下这条推文。" },
      { role: "assistant", content: "这是 @mylifcc 今早那条 thread。" },
    ]);
  });

  test("sqlite store round-trip", () => {
    const dir = mkdtempSync(join(tmpdir(), "grokbox-store-"));
    const path = join(dir, "store.db");
    const db = new Database(path);
    db.run("CREATE TABLE transcript_entries (seq INTEGER PRIMARY KEY, id TEXT, entry TEXT)");
    db.run("INSERT INTO transcript_entries (seq, id, entry) VALUES (1, 't0u', ?)", [
      JSON.stringify({ kind: "message", role: "user", content: "你来辅助我了解grok bot本身。" }),
    ]);
    db.run("INSERT INTO transcript_entries (seq, id, entry) VALUES (2, 't0s0', ?)", [
      JSON.stringify({ kind: "send-message", message: { type: "text", content: "行。" } }),
    ]);
    db.close();
    expect(readProductHistory(path)[0]).toEqual({ role: "user", content: "你来辅助我了解grok bot本身。" });
  });

  test("merges early store turns when live prompt only has the compacted ping window", () => {
    const live = {
      messages: [
        { role: "user" as const, content: "<user_query>\n[t96u]\nping — reply with exactly: pong" },
        { role: "assistant" as const, content: "pong" },
        { role: "user" as const, content: "作者 handle 是什么？" },
      ],
    };
    const merged = mergeLivePromptWithProductHistory(live, [
      { role: "user", content: "你来辅助我了解grok bot本身。" },
      { role: "assistant", content: "行。我就是 grok bot。" },
      { role: "user", content: "https://x.com/mylifcc/status/2093197189116023062 看一下这条推文。" },
      { role: "assistant", content: "这是 @mylifcc 今早那条 thread。" },
    ]);
    expect(merged.messages.some((message) => String(message.content).includes("mylifcc"))).toBe(true);
    expect(merged.messages[0]).toEqual({ role: "user", content: "你来辅助我了解grok bot本身。" });
    expect(merged.messages.at(-1)).toEqual({ role: "user", content: "作者 handle 是什么？" });
    const covered = mergeLivePromptWithProductHistory({
      messages: [
        { role: "user", content: "你来辅助我了解grok bot本身。" },
        { role: "user", content: "later" },
      ],
    }, [{ role: "user", content: "你来辅助我了解grok bot本身。" }]);
    expect(covered.messages).toHaveLength(2);
  });
});
