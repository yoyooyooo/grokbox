import { describe, expect, test } from "bun:test";
import { callStubModeld, submitPartsFromResponse } from "../src/modeld-ipc.ts";
import { startStubModeldServer } from "../src/modeld-serve.ts";
import { modeldFixture, submitRequest } from "./modeld-fixture.ts";

describe("T5b S2 streaming IPC", () => {
  test("submit writes chunk frames before the terminal submit; Host-facing parts are not empty-by-policy", async () => {
    const f = await modeldFixture();
    const server = await startStubModeldServer({ runRoot: f.runRoot, durableRoot: f.durable });
    try {
      const seen: string[] = [];
      const response = await callStubModeld(
        f.runRoot,
        submitRequest(server, "inv-s2"),
        5_000,
        undefined,
        (part) => { seen.push(part.type); },
      );
      expect(seen).toEqual(["text-delta", "finish"]);
      const result = submitPartsFromResponse(response);
      expect(result.dispatched).toBe(true);
      expect(result.parts.some((part) => part.type === "text-delta")).toBe(true);
    } finally {
      await server.stop();
    }
  });
});
