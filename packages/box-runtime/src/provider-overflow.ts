/** Log-only overflow classification. Never changes Host-visible errors or triggers compact. */

export const PROVIDER_OVERFLOW_CODES = new Set([
  "context_length_exceeded",
  "context_window_exceeded",
  "prompt_too_long",
  "request_too_large",
]);

export const PROVIDER_OVERFLOW_MESSAGE =
  /context[_ ]length exceeded|maximum context length|context window is|prompt is too long|too many tokens|exceeds the context window|input is too long|request too large/i;

export const PROVIDER_OVERFLOW_REASON_TAGS = new Set(["provider_code", "status_message"]);

export type ProviderErrorHint = {
  modelId?: string;
  api?: "chat" | "responses";
  promptMessages?: number;
  promptChars?: number;
  agentId?: string;
  invocationId?: string;
};

export type ProviderErrorEvidence = {
  overflowCandidate: boolean;
  overflowReasons: string[];
  status?: number;
  providerCode?: string;
  providerType?: string;
  bodySnippet?: string;
  modelId?: string;
  api?: "chat" | "responses";
  promptMessages?: number;
  promptChars?: number;
  agentId?: string;
  invocationId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function redactSnippet(text: string): string {
  const cleaned = text
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/syncred_[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/(api[_-]?key|authorization)[=:]\s*\S+/gi, "$1=[redacted]")
    .replace(/[\n\r]+/g, " ")
    .trim();
  return cleaned.length > 240 ? `${cleaned.slice(0, 239)}…` : cleaned;
}

function asStatus(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 100 || value > 599) return undefined;
  return value;
}

function asToken(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  if (!text || text.length > 64 || !/^[A-Za-z0-9_.-]+$/.test(text)) return undefined;
  return text;
}

function collect(error: unknown): { status?: number; code?: string; type?: string; snippet: string } {
  const texts: string[] = [];
  let status: number | undefined;
  let code: string | undefined;
  let type: string | undefined;
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number) => {
    if (value === null || value === undefined || depth > 5 || seen.has(value)) return;
    if (typeof value === "string") {
      const text = value.trim();
      if (!text) return;
      texts.push(text);
      if (text.startsWith("{") || text.startsWith("[")) {
        try { visit(JSON.parse(text), depth + 1); } catch { /* not JSON */ }
      }
      return;
    }
    if (typeof value === "number") return;
    if (!isRecord(value) && !(value instanceof Error)) return;
    seen.add(value);
    const record = value instanceof Error
      ? { name: value.name, message: value.message, ...(isRecord(value) ? value : {}) }
      : value;
    status ??= asStatus(record.statusCode) ?? asStatus(record.status) ?? asStatus(record.status_code);
    code ??= asToken(record.code);
    type ??= asToken(record.type);
    if (typeof record.message === "string" && record.message.trim()) texts.push(record.message);
    if (typeof record.responseBody === "string" && record.responseBody.trim()) texts.push(record.responseBody);
    if (typeof record.body === "string" && record.body.trim()) texts.push(record.body);
    for (const key of ["error", "data", "cause", "response"]) {
      if (key in record) visit(record[key], depth + 1);
    }
  };
  visit(error, 0);
  return { status, code, type, snippet: redactSnippet(texts.join(" ")) };
}

/** Conservative: unknown/generic failures are not overflow. */
export function inspectProviderError(error: unknown, hint: ProviderErrorHint = {}): ProviderErrorEvidence {
  const bag = collect(error);
  const overflowReasons: string[] = [];
  if (bag.code && PROVIDER_OVERFLOW_CODES.has(bag.code.toLowerCase())) overflowReasons.push("provider_code");
  if ((bag.status === 400 || bag.status === 413) && bag.snippet && PROVIDER_OVERFLOW_MESSAGE.test(bag.snippet)) {
    overflowReasons.push("status_message");
  }
  return {
    overflowCandidate: overflowReasons.length > 0,
    overflowReasons,
    ...(bag.status !== undefined ? { status: bag.status } : {}),
    ...(bag.code ? { providerCode: bag.code } : {}),
    ...(bag.type ? { providerType: bag.type } : {}),
    ...(bag.snippet ? { bodySnippet: bag.snippet } : {}),
    ...(hint.modelId ? { modelId: hint.modelId } : {}),
    ...(hint.api ? { api: hint.api } : {}),
    ...(hint.promptMessages !== undefined ? { promptMessages: hint.promptMessages } : {}),
    ...(hint.promptChars !== undefined ? { promptChars: hint.promptChars } : {}),
    ...(hint.agentId ? { agentId: hint.agentId } : {}),
    ...(hint.invocationId ? { invocationId: hint.invocationId } : {}),
  };
}

export function livePromptSize(messages: Array<{ content?: unknown }>): { promptMessages: number; promptChars: number } {
  let promptChars = 0;
  for (const message of messages) {
    const content = message.content;
    if (typeof content === "string") promptChars += content.length;
  }
  return { promptMessages: messages.length, promptChars };
}
