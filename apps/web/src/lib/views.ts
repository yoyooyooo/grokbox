import { ManagementClientError, type ApiError, type ApiReply } from "@grokbox/client";
export type ReadView<T> = { data: T; error?: never } | { data?: never; error: Pick<ApiError, "code" | "message"> };
export async function readView<T>(read: Promise<ApiReply<T> & { ok: true }>): Promise<ReadView<T>> {
  try { return { data: (await read).data }; }
  catch (error) { return { error: error instanceof ManagementClientError ? { code: error.code, message: error.message }
    : { code: "unavailable", message: "读取暂不可用；没有以空结果替代来源错误。" } }; }
}
export function denied<T>(): ReadView<T> { return { error: { code: "permission_denied", message: "当前主体没有此读取权限。" } }; }
export function viewError(view: { error?: Pick<ApiError, "code" | "message"> }): ManagementClientError | undefined {
  return view.error ? new ManagementClientError(view.error.code, view.error.message) : undefined;
}
export function boundedSearch(value: unknown, max = 256): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;
}
