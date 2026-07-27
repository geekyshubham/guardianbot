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

export async function installationClient(
  appId: string,
  privateKey: string,
  installationId: number,
  repositoryIds?: number[]
): Promise<GitHubClient> {
  const appClient = new GitHubClient(createAppJwt(appId, privateKey));
  const token = await appClient.request<{ token: string }>(
    "POST",
    `/app/installations/${installationId}/access_tokens`,
    repositoryIds?.length ? { repository_ids: repositoryIds } : {}
  );
  return new GitHubClient(token.token);
}
