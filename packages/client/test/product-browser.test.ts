import { expect, test } from "bun:test";
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { createContext, runInContext } from "node:vm";
import { fileURLToPath } from "node:url";
import { canonicalJson as nodeCanonical, sha256Text as nodeHash } from "../../runtime-kernel/src/hash.ts";
import { canonicalJson, sha256Bytes, sha256Text } from "../../runtime-kernel/src/portable-hash.ts";
import { ContinuityFailure as oldError } from "../../runtime-kernel/src/internal/continuity/material.ts";
import { ContinuityFailure as pureError } from "../../runtime-kernel/src/internal/continuity/primitives.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
test("portable SHA-256 preserves Node identities across UTF-8, padding and binary boundaries", () => {
  expect(sha256Text("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  expect(sha256Text("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  for (const text of ["中文 🐈", "a\u0000b", "\ud800", "\udfff", ...[1, 55, 56, 63, 64, 65, 127, 128, 1024, 65536].map(n => "a".repeat(n))])
    expect(sha256Text(text)).toBe(nodeHash(text));
  for (const n of [0, 1, 55, 56, 63, 64, 65, 127, 128, 1024, 65536]) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37) % 256);
    expect(sha256Bytes(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  }
  const value = JSON.parse('{"z":[{"b":2,"a":1}],"__proto__":{"a":true},"n":null}');
  expect(canonicalJson(value)).toBe('{"__proto__":{"a":true},"n":null,"z":[{"a":1,"b":2}]}');
  expect(canonicalJson(value)).toBe(nodeCanonical(value));
  expect(sha256Text(canonicalJson(value))).toBe(nodeHash(nodeCanonical(value)));
  expect(oldError).toBe(pureError);
});

test("bundled browser product validation executes without Node globals and rejects forged object receipts", async () => {
  const bundle = await build({ absWorkingDir: root, stdin: { contents: `
    export { productObject, productIntent, productPlan, assertProductResult, assertProductReceipt } from "@grokbox/runtime-kernel/products";
    export { productReceiptView, productListView, productReference } from "./product-contract.ts";
    export { sha256Text } from "../../runtime-kernel/src/portable-hash.ts";
  `, resolveDir: fileURLToPath(new URL("../src/", import.meta.url)), sourcefile: "browser-product-entry.ts" }, bundle: true, platform: "browser", format: "iife",
    globalName: "Products", write: false, metafile: true, logLevel: "silent" });
  const code = bundle.outputFiles[0]!.text;
  expect(code).not.toMatch(/node:|bun:|from ["']effect/);
  const context = createContext({ TextEncoder });
  runInContext(code, context);
  expect(runInContext('[typeof process, typeof require, typeof Buffer].join(",")', context)).toBe("undefined,undefined,undefined");
  const output = runInContext(`(() => {
    const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", request="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", installation="cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const object=Products.productObject({id,name:"中文 Bot",description:"safe",title:"Note | owner=box",avatarShape:null,avatarColor:null,harness:"box"});
    const intent=Products.productIntent({requestId:request,kind:"bot",action:"update",targetId:id,profile:{name:"中文 Bot"}});
    const result={nativeReceipt:"returned",targetId:id,readBack:"matched",object,cleanup:"not-applicable",atomicCompareAndSet:false,relationshipsTransferred:false,fullClone:false};
    const receipt={requestId:request,operationId:request,installationId:installation,principalId:"owner",scopeId:"a".repeat(64),intent,planRevision:"b".repeat(64),state:"complete",result,diagnostic:null,createdAtMs:1};
    const valid=Products.productReceiptView(receipt,installation,receipt.scopeId,request);
    const forged=JSON.parse(JSON.stringify(receipt));forged.result.object.revision="0".repeat(64);
    const inconsistent=JSON.parse(JSON.stringify(receipt));inconsistent.result.nativeReceipt="not-dispatched";
    const list={objects:[{...object,ref:Products.productReference("bot",installation,id)}],scopeId:receipt.scopeId,sourceGeneration:"c".repeat(64),revision:"d".repeat(64),total:1,nextCursor:null,pageBound:null,coverage:"current-native-roster"};
    return JSON.stringify({object,valid,forgedAccepted:Products.productReceiptView(forged,installation,receipt.scopeId,request),inconsistentAccepted:Products.productReceiptView(inconsistent,installation,receipt.scopeId,request),listValid:Products.productListView(list,installation,1),hash:Products.sha256Text("中文 🐈")});
  })()`, context) as string;
  const data = JSON.parse(output), { revision, ...body } = data.object;
  expect(revision).toBe(nodeHash(nodeCanonical(body)));
  expect(data).toMatchObject({ valid: true, forgedAccepted: false, inconsistentAccepted: false, listValid: true, hash: nodeHash("中文 🐈") });
});
