import type { ArgumentSpec, LeafCommand, OptionSpec } from "./registry.ts";

const option = (flags: string, description: string): OptionSpec => ({ flags, description });
const json = option("--json", "Write JSON");
const scope = option("--scope <local|target>", "Explicit configuration destination, never inferred from a remote Profile");
const revision = option("--expect-revision <sha>", "Compare the observed configuration revision before committing");
const confirm = option("--confirm", "Approve the specified operation and its impact");
const preview = option("--preview", "Validate and show a redacted plan without writing");
const operation = option("--operation-id <id>", "Stable identity for retries and commit reconciliation");
const replace = option("--replace", "Explicitly replace complete arrays; requires revision and confirmation");
const wait = option("--wait-applied", "Wait for a matching live consumer receipt; never start or restart services");
const waitTimeout = option("--timeout-ms <n>", "Bounded application wait, 1–120000 milliseconds (default 65000)");
const path: ArgumentSpec = { syntax: "<path>", description: "Dotted path or RFC6901 JSON Pointer" };
const make = (name: string, summary: string, args: ArgumentSpec[] = [], extras: OptionSpec[] = [], destructive = false): LeafCommand => ({
  path: ["config", name], usage: `grokbox config ${name}${args.map((arg) => ` ${arg.syntax}`).join("")}`,
  summary, arguments: args, options: [json, ...extras], stdin: "none", table: false,
  timeout: extras.some((value) => value.flags.startsWith("--timeout-ms")), destructive, gateway: false,
  streaming: false, profile: false,
});
export const CONFIG_COMMANDS: readonly LeafCommand[] = [
  make("get", "Read redacted stored configuration or resolved defaults without starting services.", [{ ...path, syntax: "[path]" }], [scope, option("--effective", "Resolve versioned defaults; application evidence is reported separately")]),
  make("set", "Validate and commit one value through the canonical configuration writer.", [path, { syntax: "[json-value]", description: "Strict JSON scalar/object/array; use --string for a literal string" }], [scope, revision, confirm, preview, operation, replace,
    option("--string <literal>", "An explicit string rather than inferred JSON"), option("--value-file <file>", "Read a bounded JSON input file"), wait, waitTimeout], true),
  make("unset", "Remove an optional explicit override, with default and permission validation.", [path], [scope, revision, confirm, preview, operation, replace, wait, waitTimeout], true),
  make("apply", "Replace a validated configuration document using expected revision and confirmation.", [], [scope, revision, confirm, preview, operation, wait, waitTimeout, option("--file <file>", "The candidate config v2 document")], true),
  make("validate", "Validate strict JSON and shared schema; never migrate or repair.", [], [option("--file <file>", "Validate an input document instead of the installed configuration")]),
  make("schema", "Show the shared schema and path capability metadata.", [{ ...path, syntax: "[path]" }]),
  make("path", "Resolve logical or physical configuration paths without parsing configuration contents.", [], [option("--physical", "Return the canonical storage path"), option("--document <config|models>", "Select the intent document")]),
  make("export", "Export portable preferences without secrets, identities, bindings or grants.", [], [option("--portable", "Explicitly request the re-bindable portable preference projection")]),
  make("preset", "Select an ops preset without issuing permissions or erasing explicit overrides.", [{ syntax: "<domain>", description: "Preset domain: ops" }, { syntax: "<name>", description: "Versioned user or maintainer preset" }], [scope, revision, confirm, preview, operation, replace, wait, waitTimeout, option("--reset-overrides", "Explicitly reset ops overrides; requires revision and confirmation")], true),
  make("migrate", "Preview or recover a one-way migration; active old writers block publication.", [], [preview, confirm,
    option("--apply", "Apply the exact previewed plan"), option("--plan-digest <sha>", "Required digest of the reviewed migration plan"),
    option("--status", "Read the migration phase"), option("--recover", "Recover an existing migration without overwriting user changes"),
    option("--role <client|box>", "Explicit installation role, never guessed from a directory"), option("--durable-root <path>", "Explicit Box deployment root"),
    option("--prefer <canonical|legacy>", "An explicit conflict choice included in the plan digest")], true),
  make("aliases", "Preview or repair managed aliases while preserving detached files and canonical data.", [], [scope, preview, confirm,
    option("--apply", "Apply or resume the reviewed alias repair"), option("--plan-digest <sha>", "Exact alias repair preview digest")], true),
  make("recover", "Inspect a writer lease or explicitly recover a proven-dead owner and reconcile a commit.", [], [scope, confirm, operation], true),
  make("bootstrap", "Prepare, install or recover this bootstrap's canonical resources; never start services.", [], [confirm, operation,
    option("--prepare", "Capture a protected rollback checkpoint before installation"),
    option("--recover", "Restore only this attempt's unchanged installed versions"),
    option("--from <file>", "Protected bootstrap resource document"), option("--durable-root <path>", "Explicit Box deployment root")], true),
];
