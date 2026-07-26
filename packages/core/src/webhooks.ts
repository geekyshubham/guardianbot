import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyWebhookSignature(
  body: Buffer,
  signature: string | undefined,
  secret: string
): boolean {
  if (!signature?.startsWith("sha256=") || !secret) return false;
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`
  );
  const actual = Buffer.from(signature);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export class DeliveryReplayGuard {
  private readonly deliveries = new Map<string, number>();

  constructor(private readonly ttlMs = 15 * 60 * 1000) {}

  accept(deliveryId: string, now = Date.now()): boolean {
    this.prune(now);
    if (this.deliveries.has(deliveryId)) return false;
    this.deliveries.set(deliveryId, now);
    return true;
  }

  private prune(now: number): void {
    for (const [id, timestamp] of this.deliveries) {
      if (now - timestamp > this.ttlMs) this.deliveries.delete(id);
    }
  }
}

