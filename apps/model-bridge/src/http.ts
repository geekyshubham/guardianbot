import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BridgeError } from "./errors.js";

export async function readJsonBody(
  request: IncomingMessage,
  maxBytes: number
): Promise<unknown> {
  const contentLength = request.headers["content-length"];
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new BridgeError(
      "payload_too_large",
      "request body too large",
      413,
      false
    );
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new BridgeError(
        "payload_too_large",
        "request body too large",
        413,
        false
      );
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new BridgeError("bad_request", "request body is not valid JSON", 400, false);
  }
}

export async function readResponseJsonLimited(
  response: Response,
  maxBytes: number
): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && Number(contentLength) > maxBytes) {
    throw new BridgeError(
      "invalid_output",
      "response body too large",
      503,
      true
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new BridgeError("invalid_output", "missing response body", 503, true);
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new BridgeError(
          "invalid_output",
          "response body too large",
          503,
          true
        );
      }
      chunks.push(value);
    }

    try {
      return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
    } catch {
      throw new BridgeError("invalid_output", "response body is not valid JSON", 503, true);
    }
  } finally {
    // Always release the upstream connection, including the oversize and parse-failure
    // paths. Cleanup must never replace the original failure.
    await reader.cancel().catch(() => undefined);
  }
}

export function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown
): void {
  const payload = JSON.stringify(body);
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(payload));
  response.end(payload);
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
