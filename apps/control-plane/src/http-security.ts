import { timingSafeEqual } from "node:crypto";

export function metricsRequestAuthorized(
  authorization: string | undefined,
  configuredToken: string | undefined,
  trustPrivateNetwork: boolean
): boolean {
  if (!configuredToken) return trustPrivateNetwork;
  if (!authorization?.startsWith("Bearer ")) return false;

  const supplied = Buffer.from(authorization.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(configuredToken, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
