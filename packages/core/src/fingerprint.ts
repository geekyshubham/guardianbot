import { createHash } from "node:crypto";

export function stableFingerprint(parts: Array<string | number | undefined>): string {
  const canonical = parts
    .map((part) => String(part ?? "").trim().toLowerCase())
    .join("\u001f");
  return createHash("sha256").update(canonical).digest("hex");
}

