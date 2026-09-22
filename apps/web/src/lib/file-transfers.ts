import { FILE_POLICY, ManagementClientError, type ManagementClient, type FileChange, type FileOperation, type FileUpload } from "@grokbox/client";

export async function browserFileDigest(file: File): Promise<string> {
  if (file.size > FILE_POLICY.maxBytes) throw new ManagementClientError("invalid_input", "The selected file exceeds the 64 MiB transfer limit.");
  return digest(await file.arrayBuffer());
}
async function digest(bytes: ArrayBuffer): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), n => n.toString(16).padStart(2, "0")).join("");
}
function base64(bytes: Uint8Array): string {
  let value = ""; for (const byte of bytes) value += String.fromCharCode(byte); return btoa(value);
}
/** The browser only transports explicitly selected bytes. The server owns the
 * original publication guard; no client reconnect retries a mutation. */
export async function publishBrowserFile(client: ManagementClient, request: FileChange, file?: File): Promise<FileOperation> {
  let opened: FileUpload | undefined, commitStarted = false;
  try {
    const reply = (await client.changeFile(request)).data;
    if (!("chunks" in reply)) return reply;
    opened = reply;
    if (!file || request.action !== "upload" || file.size !== opened.size) throw new ManagementClientError("invalid_input", "The selected upload no longer matches its reviewed size.");
    for (let index = 0; index < opened.chunks; index++) {
      const bytes = new Uint8Array(await file.slice(index * opened.chunkBytes, (index + 1) * opened.chunkBytes).arrayBuffer());
      await client.uploadFileChunk({ requestId: opened.requestId, generation: opened.generation, index, contentBase64: base64(bytes) });
    }
    commitStarted = true;
    return (await client.controlFileUpload({ requestId: opened.requestId, generation: opened.generation, action: "commit" })).data;
  } catch (error) {
    if (opened && !commitStarted) await client.controlFileUpload({ requestId: opened.requestId, generation: opened.generation, action: "cancel" }).catch(() => undefined);
    throw error;
  }
}
export async function downloadBrowserFile(client: ManagementClient, ref: string, name: string): Promise<{ size: number; sha256: string }> {
  const opened = (await client.openFileDownload({ requestId: crypto.randomUUID(), ref })).data;
  try {
    const bytes = new Uint8Array(opened.size); let offset = 0;
    for (let index = 0; index < opened.chunks; index++) {
      const row = (await client.downloadFileChunk(opened, index)).data, text = atob(row.contentBase64);
      for (let n = 0; n < text.length; n++) bytes[offset + n] = text.charCodeAt(n);
      offset += text.length;
    }
    if (offset !== opened.size || await digest(bytes.buffer) !== opened.sha256) throw new ManagementClientError("protocol_error", "The downloaded bytes do not match their pinned digest; no browser download was started.");
    const href = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" })), anchor = document.createElement("a");
    anchor.href = href; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
    return { size: opened.size, sha256: opened.sha256 };
  } finally { await client.closeFileDownload(opened).catch(() => undefined); }
}
