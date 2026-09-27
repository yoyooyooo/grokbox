import { expect, test } from "bun:test";
import { productIntent, productObject, productResultMatches } from "../src/internal/continuity/native-product.ts";

const requestId = "11111111-1111-4111-8111-111111111111";
const id = "22222222-2222-4222-8222-222222222222";
const create = (profile: Record<string, string>) => productIntent({ requestId, kind: "bot", action: "create", harness: "box", deferStart: true, profile });
const observed = productObject({ id, name: "quiet", description: "no introduction", title: "", avatarShape: "squircle", avatarColor: "red", harness: "box", isGroup: false });

test("native defaults for omitted create fields do not become a readback mismatch", () => {
  const intent = create({ name: "quiet", description: "no introduction" });
  expect(intent.profile).toEqual({ name: "quiet", description: "no introduction" });
  expect(productResultMatches(intent, observed)).toBe(true);
  expect(productResultMatches(create({ name: "quiet", description: "no introduction", avatarColor: "blue" }), observed)).toBe(false);
  expect(() => create({ description: "missing name" })).toThrow();
});

test("explicit fields in an existing create declaration remain intact", () => {
  const profile = { name: "quiet", description: "no introduction", title: "", avatarShape: "", avatarColor: "" };
  expect(create(profile).profile).toEqual(profile);
  expect(productResultMatches(create(profile), observed)).toBe(false);
});
