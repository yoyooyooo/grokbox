import { BoxRuntimeError } from "@grokbox/runtime-kernel/contract";

export type LocalRuntimeContext = {
  sshHost?: string;
  daemonServerUrl?: string;
  transport?: string;
  profileName?: string;
};

export function assertBoxLocal(context: LocalRuntimeContext): void {
  // A local default Profile name is not a remote transport. `--profile` on
  // localOnly commands is rejected at the CLI registry before this guard.
  if (
    context.sshHost ||
    context.daemonServerUrl ||
    context.transport === "daemon" ||
    context.transport === "gateway"
  ) {
    throw new BoxRuntimeError(
      "runtime_local_only",
      "Box-local runtime commands cannot use --profile, daemon, SSH, or generic remote exec.",
    );
  }
}
