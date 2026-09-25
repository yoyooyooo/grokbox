import type { ProductDiagnostic } from "@grokbox/runtime-kernel/continuity";

export type ProductFailureObservation = Omit<ProductDiagnostic, "observedAtMs" | "detailStored">;
export const PRODUCT_FAILURE_DETAIL_BYTES = 8192;

/** Error bodies stay in the private CONT store, never Error serialization or
 * the management response. They are diagnostic evidence, not effect settlement. */
export class ProductCallFailure extends Error {
  declare readonly privateDetail: string | null;
  constructor(readonly observation: ProductFailureObservation, detail: string | null = null) {
    super("native_product_call_failed");
    this.name = "ProductCallFailure";
    Object.defineProperty(this, "privateDetail", { value: detail === null ? null
      : new TextDecoder().decode(Buffer.from(detail).subarray(0, PRODUCT_FAILURE_DETAIL_BYTES), { stream: true }), enumerable: false });
  }
}

export function productCallFailure(error: unknown, method: string | null = null): ProductCallFailure {
  if (error instanceof ProductCallFailure) return error;
  const code = error !== null && typeof error === "object" && "code" in error ? error.code : null;
  return new ProductCallFailure({ phase: "dispatch", code:
    code === "source_unavailable" || code === "source_unauthorized" || code === "source_timeout"
      || code === "source_invalid" || code === "source_changed" ? code : "unexpected_failure",
    method, httpStatus: null }, error instanceof Error ? error.message : null);
}
