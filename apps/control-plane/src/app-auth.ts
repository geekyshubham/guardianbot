import { createSign } from "node:crypto";
import { GitHubClient } from "@guardianbot/core";

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export function createAppJwt(appId: string, privateKey: string, now = Date.now()): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iat: Math.floor(now / 1000) - 60,
    exp: Math.floor(now / 1000) + 540,
    iss: appId
  }));
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey);
  return `${unsigned}.${base64url(signature)}`;
}

/**
 * Keeps only well-formed `name: level` entries from GitHub's token response, so a malformed or
 * missing permissions object reads as "nothing granted" rather than as any particular grant.
 */
export function grantedPermissionsFrom(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return Object.freeze({});
  const granted: Record<string, string> = {};
  for (const [name, level] of Object.entries(value as Record<string, unknown>)) {
    if (/^[a-z_]{1,64}$/.test(name) && (level === "read" || level === "write" || level === "admin")) {
      granted[name] = level;
    }
  }
  return Object.freeze(granted);
}

export type InstallationGitHubClient = GitHubClient & {
  readonly grantedPermissions: Readonly<Record<string, string>>;
};

export async function installationClient(
  appId: string,
  privateKey: string,
  installationId: number,
  repositoryIds?: number[]
): Promise<InstallationGitHubClient> {
  const appClient = new GitHubClient(createAppJwt(appId, privateKey));
  const token = await appClient.request<{ token: string; permissions?: unknown }>(
    "POST",
    `/app/installations/${installationId}/access_tokens`,
    repositoryIds?.length ? { repository_ids: repositoryIds } : {}
  );
  // The permissions GitHub actually granted this token, which is what Mode C checks before it
  // attempts any repository write: the manifest default never grants contents:write.
  return Object.assign(new GitHubClient(token.token), {
    grantedPermissions: grantedPermissionsFrom(token.permissions)
  });
}
