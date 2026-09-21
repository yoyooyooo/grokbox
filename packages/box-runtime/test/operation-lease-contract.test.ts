import { expect, test } from "bun:test";
import { parseOperationLeaseOwner, operationOwnerState } from "../src/internal/io/operation-lease.node.ts";

const owner = () => ({ version: 1 as const, pid: 321, uid: 1000, start: "9876",
  bootId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", nonce: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", operationId: "owned-operation" });

test("operation owner parsing requires exact own data, does not evaluate getters and detaches the captured identity", async () => {
  const source = owner(), parsed = parseOperationLeaseOwner(source);
  expect(parsed).toEqual(source); expect(parsed).not.toBe(source);
  source.pid = 654; expect(parsed?.pid).toBe(321);
  let evaluated = 0;
  const accessor = { ...owner(), get version() { evaluated++; return 1; } };
  const inherited = Object.create(owner());
  const hidden = Object.defineProperty(owner(), "pid", { value: 321, enumerable: false });
  const symbol = { ...owner(), [Symbol("hidden-authority")]: true };
  for (const candidate of [accessor, inherited, hidden, symbol, { ...owner(), extra: true }, { version: 0, pid: 321 }, "321", null]) {
    expect(parseOperationLeaseOwner(candidate)).toBeNull();
    expect(await operationOwnerState(candidate as never)).toBe("unproven");
  }
  expect(evaluated).toBe(0);
  expect(parseOperationLeaseOwner(Object.assign(Object.create(null), owner()))).toEqual(owner());
});
