import {
  createPublicKey,
  verify as verifySignature,
  type JsonWebKey as NodeJsonWebKey
} from "node:crypto";

const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_OIDC_JWKS_URL =
  "https://token.actions.githubusercontent.com/.well-known/jwks";
const JWKS_CACHE_MS = 5 * 60 * 1_000;
const CLOCK_SKEW_SECONDS = 30;
const MAX_GITHUB_TOKEN_LIFETIME_SECONDS = 10 * 60;

export interface GitHubOidcClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nbf?: number;
  repository: string;
  repository_id: string;
  run_id: string;
  run_attempt: string;
  sha: string;
  ref?: string;
  ref_type?: string;
  event_name?: string;
  workflow_ref?: string;
  workflow_sha?: string;
  runner_environment?: string;
  sub: string;
  environment?: string;
  job_workflow_ref: string;
  job_workflow_sha?: string;
}

export interface GitHubOidcVerifier {
  verify(token: string): Promise<GitHubOidcClaims>;
}

export class GitHubOidcVerificationError extends Error {
  constructor(
    message: string,
    readonly statusCode: 401 | 503
  ) {
    super(message);
  }
}

interface GitHubOidcVerifierOptions {
  audience: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface JwtHeader {
  alg: string;
  kid: string;
  typ?: string;
}

interface OidcJsonWebKey extends NodeJsonWebKey {
  alg?: string;
  kid?: string;
  use?: string;
}

interface JsonWebKeySet {
  keys?: OidcJsonWebKey[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function decodeJsonSegment(
  value: string,
  label: string
): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 16_384) {
    throw new GitHubOidcVerificationError(`${label} is invalid`, 401);
  }
  try {
    const bytes = Buffer.from(value, "base64url");
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    );
    const record = asRecord(parsed);
    if (!record) throw new Error("not an object");
    return record;
  } catch {
    throw new GitHubOidcVerificationError(`${label} is invalid`, 401);
  }
}

function numericClaim(
  claims: Record<string, unknown>,
  name: string
): number {
  const value = claims[name];
  const numberValue =
    typeof value === "string" && /^[0-9]+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(numberValue) || Number(numberValue) <= 0) {
    throw new GitHubOidcVerificationError(
      `OIDC ${name} claim is invalid`,
      401
    );
  }
  return Number(numberValue);
}

function optionalString(
  claims: Record<string, unknown>,
  name: string
): string | undefined {
  return claims[name] === undefined ? undefined : String(claims[name]);
}

function parseOidcClaims(
  value: Record<string, unknown>
): GitHubOidcClaims {
  const aud = value.aud;
  if (
    typeof aud !== "string" &&
    (!Array.isArray(aud) ||
      aud.length === 0 ||
      aud.some((entry) => typeof entry !== "string"))
  ) {
    throw new GitHubOidcVerificationError("OIDC aud claim is invalid", 401);
  }
  return {
    iss: String(value.iss ?? ""),
    aud: aud as string | string[],
    exp: numericClaim(value, "exp"),
    iat: numericClaim(value, "iat"),
    nbf: value.nbf === undefined ? undefined : numericClaim(value, "nbf"),
    repository: String(value.repository ?? ""),
    repository_id: String(value.repository_id ?? ""),
    run_id: String(value.run_id ?? ""),
    run_attempt: String(value.run_attempt ?? ""),
    sha: String(value.sha ?? ""),
    ref: optionalString(value, "ref"),
    ref_type: optionalString(value, "ref_type"),
    event_name: optionalString(value, "event_name"),
    workflow_ref: optionalString(value, "workflow_ref"),
    workflow_sha: optionalString(value, "workflow_sha"),
    runner_environment: optionalString(value, "runner_environment"),
    sub: String(value.sub ?? ""),
    environment: optionalString(value, "environment"),
    job_workflow_ref: String(value.job_workflow_ref ?? ""),
    job_workflow_sha: optionalString(value, "job_workflow_sha")
  };
}

export async function readBoundedJsonResponse(
  response: Response,
  maxBytes: number
): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error("JSON response exceeded its size limit");
  }
  if (!response.body) throw new Error("JSON response body is missing");
  const chunks: Uint8Array[] = [];
  let received = 0;
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error("JSON response exceeded its size limit");
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  );
}

export function createGitHubOidcVerifier(
  options: GitHubOidcVerifierOptions
): GitHubOidcVerifier {
  if (
    !options.audience ||
    options.audience.length > 128 ||
    !/^[A-Za-z0-9._:-]+$/.test(options.audience)
  ) {
    throw new Error("GitHub OIDC audience is invalid");
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  let cachedKeys:
    | { expiresAt: number; keys: OidcJsonWebKey[] }
    | undefined;

  async function loadJwks(forceRefresh = false): Promise<OidcJsonWebKey[]> {
    const current = now().getTime();
    if (!forceRefresh && cachedKeys && cachedKeys.expiresAt > current) {
      return cachedKeys.keys;
    }
    let response: Response;
    try {
      response = await fetchImpl(GITHUB_OIDC_JWKS_URL, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(10_000)
      });
    } catch {
      throw new GitHubOidcVerificationError(
        "GitHub OIDC keys are temporarily unavailable",
        503
      );
    }
    if (!response.ok) {
      throw new GitHubOidcVerificationError(
        "GitHub OIDC keys are temporarily unavailable",
        503
      );
    }
    let document: JsonWebKeySet;
    try {
      document = (await readBoundedJsonResponse(
        response,
        256 * 1024
      )) as JsonWebKeySet;
    } catch {
      throw new GitHubOidcVerificationError(
        "GitHub OIDC keys are temporarily unavailable",
        503
      );
    }
    const keys = Array.isArray(document.keys)
      ? document.keys.filter(
          (key) =>
            key &&
            key.kty === "RSA" &&
            typeof key.kid === "string" &&
            key.kid.length > 0 &&
            (!key.use || key.use === "sig") &&
            (!key.alg || key.alg === "RS256")
        )
      : [];
    if (!keys.length) {
      throw new GitHubOidcVerificationError(
        "GitHub OIDC keys are temporarily unavailable",
        503
      );
    }
    cachedKeys = { expiresAt: current + JWKS_CACHE_MS, keys };
    return keys;
  }

  return {
    async verify(token: string): Promise<GitHubOidcClaims> {
      if (token.length > 32_768) {
        throw new GitHubOidcVerificationError("OIDC token is invalid", 401);
      }
      const segments = token.split(".");
      if (
        segments.length !== 3 ||
        !segments[0] ||
        !segments[1] ||
        !segments[2] ||
        !/^[A-Za-z0-9_-]+$/.test(segments[2]) ||
        segments[2].length > 4_096
      ) {
        throw new GitHubOidcVerificationError("OIDC token is invalid", 401);
      }
      const headerRecord = decodeJsonSegment(segments[0], "OIDC header");
      const header: JwtHeader = {
        alg: String(headerRecord.alg ?? ""),
        kid: String(headerRecord.kid ?? ""),
        typ:
          headerRecord.typ === undefined
            ? undefined
            : String(headerRecord.typ)
      };
      if (
        header.alg !== "RS256" ||
        !header.kid ||
        (header.typ !== undefined && header.typ !== "JWT")
      ) {
        throw new GitHubOidcVerificationError("OIDC header is invalid", 401);
      }
      let keys = await loadJwks();
      let jwk = keys.find((candidate) => candidate.kid === header.kid);
      if (!jwk) {
        keys = await loadJwks(true);
        jwk = keys.find((candidate) => candidate.kid === header.kid);
      }
      if (!jwk) {
        throw new GitHubOidcVerificationError(
          "OIDC signing key is unknown",
          401
        );
      }
      let verified = false;
      try {
        const publicKey = createPublicKey({ key: jwk, format: "jwk" });
        verified = verifySignature(
          "RSA-SHA256",
          Buffer.from(`${segments[0]}.${segments[1]}`, "utf8"),
          publicKey,
          Buffer.from(segments[2], "base64url")
        );
      } catch {
        verified = false;
      }
      if (!verified) {
        throw new GitHubOidcVerificationError(
          "OIDC signature is invalid",
          401
        );
      }
      const claims = parseOidcClaims(
        decodeJsonSegment(segments[1], "OIDC claims")
      );
      const nowSeconds = Math.floor(now().getTime() / 1_000);
      if (
        claims.iss !== GITHUB_OIDC_ISSUER ||
        !(Array.isArray(claims.aud)
          ? claims.aud.includes(options.audience)
          : claims.aud === options.audience) ||
        claims.exp <= nowSeconds - CLOCK_SKEW_SECONDS ||
        claims.iat > nowSeconds + CLOCK_SKEW_SECONDS ||
        (claims.nbf !== undefined &&
          claims.nbf > nowSeconds + CLOCK_SKEW_SECONDS) ||
        claims.exp <= claims.iat ||
        claims.exp - claims.iat > MAX_GITHUB_TOKEN_LIFETIME_SECONDS ||
        !claims.sub
      ) {
        throw new GitHubOidcVerificationError(
          "OIDC claims are invalid or expired",
          401
        );
      }
      return claims;
    }
  };
}
