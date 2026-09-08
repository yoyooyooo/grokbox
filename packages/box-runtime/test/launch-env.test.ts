import { describe, expect, test } from "bun:test";
import { envHasProviderCredential, fillMissingLaunchEnv, pickLaunchEnv } from "../src/launch-env.ts";

describe("identity launch allowlist", () => {
  test("copies approved Host launch fields and excludes provider keys", () => {
    const picked = pickLaunchEnv({
      HOME: "/home/box",
      PATH: "/usr/bin",
      SAND_DATA_ROOT: "/home/box/sand-data",
      SAND_GATEWAY_TOKEN: "not-logged",
      SAND_INFERENCE_RENEWAL_CREDENTIAL: "not-logged-renewal",
      ACME_KEY: "sk-should-not-copy",
      OPENAI_API_KEY: "sk-no",
    });
    expect(picked.ok).toBe(true);
    if (!picked.ok) return;
    expect(picked.env.HOME).toBe("/home/box");
    expect(picked.env.SAND_DATA_ROOT).toBe("/home/box/sand-data");
    expect(picked.env.SAND_INFERENCE_RENEWAL_CREDENTIAL).toBe("not-logged-renewal");
    expect(picked.env.ACME_KEY).toBeUndefined();
    expect(picked.env.OPENAI_API_KEY).toBeUndefined();
    expect(envHasProviderCredential({ ACME_KEY: "x" })).toBe(true);
    expect(envHasProviderCredential(picked.env)).toBe(false);
  });

  test("fills official renewer from supervisor when the current Host lost it", () => {
    const merged = fillMissingLaunchEnv(
      { HOME: "/home/box", SAND_GATEWAY_TOKEN: "gw" },
      { SAND_INFERENCE_RENEWAL_CREDENTIAL: "from-supervisor", SAND_GATEWAY_TOKEN: "ignored", OPENAI_API_KEY: "sk-no" },
    );
    expect(merged.SAND_INFERENCE_RENEWAL_CREDENTIAL).toBe("from-supervisor");
    expect(merged.SAND_GATEWAY_TOKEN).toBe("gw");
    expect(merged.OPENAI_API_KEY).toBeUndefined();
  });
});
