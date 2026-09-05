import { BoxRuntimeError } from "./errors.ts";

export type LocalRuntimeContext = {
  sshHost?: string;
  daemonServerUrl?: string;
  transport?: string;
  profileName?: string;
};

export function assertBoxLocal(context: LocalRuntimeContext): void {
  if (
    context.profileName ||
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
