import AjvImport, { type Ajv as AjvInstance, type Options } from "ajv";
import addFormatsImport from "ajv-formats";
import YAML from "yaml";

export type ScannerMode = "advisory" | "report-only" | "enforce";

export interface GuardianConfig {
  schemaVersion: "1.0.0";
  workflowVersion: string;
  repository: {
    defaultBranch: string;
    releaseBranches: string[];
    languages: string[];
    relatedRepositories?: string[];
  };
  review: {
    automatic: boolean;
    drafts: "skip" | "manual" | "automatic";
    incremental: boolean;
    maxInlineComments: number;
    categories: string[];
    highRiskPaths: string[];
    contextDocuments?: string[];
    excludedPaths?: string[];
  };
  scanners: {
    mode: ScannerMode;
    semgrep: boolean;
    trivy: boolean;
    suppressions?: Array<{
      fingerprint: string;
      owner: string;
      reason: string;
      ticket: string;
      expiresAt: string;
    }>;
  };
  image?: null | {
    dockerfile: string;
    context: string;
    platform: string;
    registry: string;
    healthPath: string;
    readinessPath?: string;
    containerPort?: number;
    sbomFormat: "cyclonedx-json";
    dependentServices?: Array<"postgres" | "redis">;
    runtimeEnvironment?: Record<string, string>;
    migrationCommand?: string;
    testCommand?: string;
  };
  dast?: null | {
    allowedOrigin: string;
    openapi: string;
    authenticationProfile: string;
    sessionAssertionPath: string;
    excludedRoutes?: string[];
  };
}

const SHA_PATTERN = /^[a-f0-9]{40}$/;

export function validateGuardianConfig(config: GuardianConfig): string[] {
  const errors: string[] = [];
  if (config.schemaVersion !== "1.0.0") errors.push("schemaVersion must be 1.0.0");
  if (!SHA_PATTERN.test(config.workflowVersion)) {
    errors.push("workflowVersion must be an immutable 40-character commit SHA");
  }
  if (!config.repository.defaultBranch) errors.push("defaultBranch is required");
  if (config.review.maxInlineComments < 0 || config.review.maxInlineComments > 50) {
    errors.push("maxInlineComments must be between 0 and 50");
  }
  if (config.dast) {
    let url: URL | undefined;
    try {
      url = new URL(config.dast.allowedOrigin);
    } catch {
      errors.push("dast.allowedOrigin must be an absolute URL");
    }
    if (url && (url.pathname !== "/" || url.search || url.hash)) {
      errors.push("dast.allowedOrigin must contain only scheme, host, and optional port");
    }
    if (url && url.protocol !== "https:") {
      errors.push("dast.allowedOrigin must use HTTPS");
    }
  }
  for (const suppression of config.scanners.suppressions ?? []) {
    if (Number.isNaN(Date.parse(suppression.expiresAt))) {
      errors.push(`suppression ${suppression.fingerprint} has an invalid expiresAt`);
    }
    if (!suppression.owner || !suppression.reason || !suppression.ticket) {
      errors.push(`suppression ${suppression.fingerprint} is missing review metadata`);
    }
  }
  return errors;
}

export function parseGuardianConfig(source: string): GuardianConfig {
  const value = YAML.parse(source) as GuardianConfig;
  const errors = validateGuardianConfig(value);
  if (errors.length) throw new Error(`Invalid GuardianBot configuration:\n${errors.join("\n")}`);
  return value;
}

export function serializeGuardianConfig(config: GuardianConfig): string {
  return YAML.stringify(config, { lineWidth: 100 });
}

export function validateAgainstJsonSchema(
  schema: object,
  value: unknown
): string[] {
  const Ajv = AjvImport as unknown as new (options?: Options) => AjvInstance;
  const addFormats = addFormatsImport as unknown as (ajv: AjvInstance) => AjvInstance;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (validate(value)) return [];
  return (validate.errors ?? []).map(
    (error: { instancePath: string; message?: string }) =>
      `${error.instancePath || "/"} ${error.message ?? "is invalid"}`
  );
}
