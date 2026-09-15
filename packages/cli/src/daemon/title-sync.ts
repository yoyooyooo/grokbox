import type { GatewayClient } from "../gateway.ts";
import { applyAgentTitles, loadAssignedModelTokens } from "../title-sync.ts";
import { parseAgentTitle } from "@grokbox/runtime-kernel/contract";
import { isRecord } from "../util.ts";

export const TITLE_SYNC_INTERVAL_MS = 120_000;
export const TITLE_SYNC_TIMEOUT_MS = 15_000;

export class TitleSyncManager {
  private tick: ReturnType<typeof setInterval> | undefined;
  private locked = false;

  constructor(
    private readonly gateway: GatewayClient,
    private readonly boxRuntimeRoot: string,
    private readonly env: NodeJS.Dict<string>,
    private readonly intervalMs = TITLE_SYNC_INTERVAL_MS,
  ) {}

  capabilities(): string[] {
    return ["grok.roster.title-sync"];
  }

  start(): void {
    if (this.tick !== undefined) return;
    this.tick = setInterval(() => {
      void this.safeRun();
    }, this.intervalMs);
    this.tick.unref?.();
  }

  async close(): Promise<void> {
    if (this.tick !== undefined) {
      clearInterval(this.tick);
      this.tick = undefined;
    }
  }

  private async safeRun(): Promise<void> {
    if (this.locked) return;
    this.locked = true;
    try {
      const listed = await this.gateway.listAgents(TITLE_SYNC_TIMEOUT_MS);
      const rows = listed.agents.filter(isRecord).filter((row) => row.isGroup !== true && parseAgentTitle(row.title).showing);
      if (rows.length === 0) return;
      const tokens = await loadAssignedModelTokens(this.boxRuntimeRoot, this.env);
      await applyAgentTitles(this.gateway, TITLE_SYNC_TIMEOUT_MS, { action: "sync", rows, tokens });
    } catch {
      /* Next interval retries. A failed Server read must not stop the daemon. */
    } finally {
      this.locked = false;
    }
  }
}
