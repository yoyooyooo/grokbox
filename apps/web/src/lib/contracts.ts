import type { ApiError, ConsoleSession } from "@grokbox/client";

/** Safe to dehydrate. Authentication secrets never belong in router/query state. */
export type ConsoleBinding = { origin: string; installationId: string };
export type PublicSession = Omit<ConsoleSession, "csrfToken">;
export type ConsoleBootstrap = {
  binding: ConsoleBinding;
  session: PublicSession | null;
  error?: Pick<ApiError, "code" | "message">;
};
