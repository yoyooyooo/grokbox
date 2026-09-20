export type TargetKind = "agent" | "group";
export type TargetRole = "target" | "agent" | "group";
export type StdinPolicy = "none" | "text" | "secret" | "json";

export type ArgumentSpec = {
  syntax: string;
  description: string;
  role?: TargetRole;
  kinds?: readonly TargetKind[];
};

export type OptionSpec = {
  flags: string;
  description: string;
  required?: boolean;
};

export type LeafCommand = {
  path: readonly string[];
  usage: string;
  summary: string;
  arguments: readonly ArgumentSpec[];
  options: readonly OptionSpec[];
  stdin: StdinPolicy;
  table: boolean;
  timeout: boolean;
  destructive: boolean;
  gateway: boolean;
  streaming: boolean;
  profile?: boolean;
  localOnly?: boolean;
  protocol?: "management";
};

const JSON_OPTION: OptionSpec = { flags: "--json", description: "Write JSON" };
const TABLE_OPTION: OptionSpec = { flags: "--table", description: "Write a human-readable table" };
const TIMEOUT_OPTION: OptionSpec = {
  flags: "--timeout-ms <n>",
  description: "Finite operation timeout in milliseconds",
};

const PROFILE_OPTION: OptionSpec = { flags: "--profile <name>", description: "Select an existing Profile" };

export const GLOBAL_OPTIONS: readonly OptionSpec[] = [
  PROFILE_OPTION,
  JSON_OPTION,
  TABLE_OPTION,
  TIMEOUT_OPTION,
];

export function options(
  extras: readonly OptionSpec[] = [],
  policy: { json?: boolean; table?: boolean; timeout?: boolean } = {},
): readonly OptionSpec[] {
  return [
    ...(policy.json === false ? [] : [JSON_OPTION]),
    ...(policy.table ? [TABLE_OPTION] : []),
    ...(policy.timeout ? [TIMEOUT_OPTION] : []),
    ...extras,
  ];
}
