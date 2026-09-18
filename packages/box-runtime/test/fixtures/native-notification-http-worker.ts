import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { sendNativeNotification, NATIVE_NOTIFICATION_HTTP } from "../../src/internal/io/native-notification.node.ts";

// A dedicated Node process proves real HTTP event ordering, not Bun's node:http
// emulation. The parent owns the loopback server and synthetic-only input file.
const [inputPath, portText] = process.argv.slice(2);
const port = Number(portText);
if (!inputPath || !Number.isSafeInteger(port) || port < 1 || port > 65535) throw Error("fixture_invalid");
const input = JSON.parse(await readFile(inputPath, "utf8"));
const result = await sendNativeNotification({ ...input, signal: new AbortController().signal }, (url, options, callback) => {
  if (url.origin !== NATIVE_NOTIFICATION_HTTP.origin || options.rejectUnauthorized !== true) throw Error("fixture_untrusted_origin");
  return httpRequest({ ...options, protocol: "http:", hostname: "127.0.0.1", port, path: url.pathname }, callback);
});
process.stdout.write(JSON.stringify(result));
