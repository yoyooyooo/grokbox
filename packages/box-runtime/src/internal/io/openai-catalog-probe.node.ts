import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";
import { STUB_ECHO_MODEL_ID, type ModelRecord } from "@grokbox/runtime-kernel/selection";
import { materializeApiKeyRef } from "./credentials.node.ts";

const PROBE_TIMEOUT_MS = 8_000;

export function openaiModelsUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "");
  return base.endsWith("/v1") ? `${base}/models` : `${base}/v1/models`;
}

function listedIds(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  const rows = Array.isArray(record.data) ? record.data : Array.isArray(record.models) ? record.models : [];
  const ids: string[] = [];
  for (const row of rows) {
    if (typeof row === "string") ids.push(row);
    else if (row && typeof row === "object" && typeof (row as { id?: unknown }).id === "string") {
      ids.push((row as { id: string }).id);
    }
  }
  return ids;
}

/** GET /v1/models only. No completions/responses. Never logs the secret or URL query. */
export async function probeOpenAiCatalog(input: {
  record: ModelRecord;
  env?: NodeJS.Dict<string>;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}): Promise<void> {
  if (input.record.id === STUB_ECHO_MODEL_ID || input.record.provider === "stub") return;
  const fetchImpl = input.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new BoxRuntimeError("invalid_usage", "Model catalog probe requires fetch.");
  }
  const secret = await materializeApiKeyRef(input.record.apiKeyRef, input.env ?? process.env, input.signal);
  const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const signal = input.signal ? AbortSignal.any([input.signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetchImpl(openaiModelsUrl(input.record.endpoint), {
      method: "GET",
      headers: { authorization: `Bearer ${secret}` },
      signal,
    });
  } catch {
    throw new BoxRuntimeError("invalid_usage", "Model endpoint did not answer GET /v1/models.");
  }
  if (response.status < 200 || response.status > 299) {
    throw new BoxRuntimeError("invalid_usage", `Model catalog probe returned HTTP ${response.status}.`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new BoxRuntimeError("invalid_usage", "Model catalog probe returned a non-JSON body.");
  }
  const ids = listedIds(body);
  if (!ids.includes(input.record.model) && !ids.includes(input.record.id)) {
    throw new BoxRuntimeError("invalid_usage", `Model '${input.record.model}' was not listed by GET /v1/models.`);
  }
}
