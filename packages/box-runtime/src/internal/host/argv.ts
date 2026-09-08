export function shouldTransformArgv(argv: readonly string[]): boolean {
  if (argv.some((value) => value === "--box-copy-in" || value.startsWith("--box-copy-in="))) {
    return false;
  }
  const entry = argv.find((value, index) => index >= 1 && !value.startsWith("-")) ?? "";
  return /(^|[\\/])host-main\.cjs$/.test(entry);
}
