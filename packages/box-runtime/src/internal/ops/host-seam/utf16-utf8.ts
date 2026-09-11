/** AST offsets are UTF-16 code units. Shape artifacts use original UTF-8 bytes, end-exclusive. */

export type Utf16Range = { start: number; end: number };
export type Utf8Range = { startByte: number; endByte: number };

export function utf16RangeToUtf8(source: string, start: number, end: number): Utf8Range | undefined {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > source.length) {
    return undefined;
  }
  const startByte = Buffer.byteLength(source.slice(0, start), "utf8");
  const endByte = startByte + Buffer.byteLength(source.slice(start, end), "utf8");
  return { startByte, endByte };
}

export function utf8RangeToUtf16(source: string, startByte: number, endByte: number): Utf16Range | undefined {
  const bytes = Buffer.from(source, "utf8");
  if (!Number.isInteger(startByte) || !Number.isInteger(endByte) || startByte < 0 || endByte < startByte || endByte > bytes.length) {
    return undefined;
  }
  const prefix = bytes.subarray(0, startByte).toString("utf8");
  const window = bytes.subarray(startByte, endByte).toString("utf8");
  if (Buffer.byteLength(prefix, "utf8") !== startByte || Buffer.byteLength(window, "utf8") !== endByte - startByte) {
    return undefined;
  }
  const start = prefix.length;
  const end = start + window.length;
  if (source.slice(start, end) !== window) return undefined;
  return { start, end };
}

/** Bidirectional map + original-byte substring. Pretty-printer output is never a source of truth. */
export function verifyUtf16Utf8RoundTrip(source: string, start: number, end: number): boolean {
  const utf8 = utf16RangeToUtf8(source, start, end);
  if (!utf8) return false;
  const back = utf8RangeToUtf16(source, utf8.startByte, utf8.endByte);
  if (!back || back.start !== start || back.end !== end) return false;
  const bytes = Buffer.from(source, "utf8");
  return bytes.subarray(utf8.startByte, utf8.endByte).toString("utf8") === source.slice(start, end);
}
