import { type Ajv as AjvInstance, type Options } from "ajv";
import Ajv2020Import from "ajv/dist/2020.js";
import addFormatsImport from "ajv-formats";
import YAML from "yaml";

export type ScannerMode = "advisory" | "report-only" | "enforce";
export type ImagePromotionMode = "enforce-only" | "verified-default-branch";
export type ReviewCategory =
  | "security"
  | "logic"
  | "reliability"
  | "concurrency"
  | "performance"
  | "contract"
  | "testing"
  | "maintainability";
export type DastScanProfile =
  | "baseline"
  | "authenticated-baseline"
  | "full"
  | "authenticated-full";

export interface GuardianConfig {
  schemaVersion: "1.0.0";
  workflowVersion: string;
  repository: {
    defaultBranch: string;
    releaseBranches: string[];
    languages: string[];
    packageManagers?: string[];
    lockfiles?: string[];
    codeowners?: string;
    relatedRepositories?: string[];
  };
  paths?: {
    source: string[];
    test: string[];
    generated: string[];
    vendored: string[];
    excluded: string[];
  };
  review: {
    automatic: boolean;
    drafts: "skip" | "manual" | "automatic";
    incremental: boolean;
    manual?: boolean;
    targetBranches?: string[];
    maxInlineComments: number;
    categories: ReviewCategory[];
    highRiskPaths: string[];
    contextDocuments?: string[];
    excludedPaths?: string[];
    pathRules?: Array<{
      name: string;
      paths: string[];
      categories?: ReviewCategory[];
      instructions: string[];
    }>;
  };
  runner?: {
    executionEnvironment: "github-hosted" | "ephemeral";
    testCommands: string[];
    buildCommands: string[];
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
    name?: string;
    dockerfile: string;
    context: string;
    platform: string;
    buildArguments?: Record<string, string>;
    smokeProfile?: "http" | "command" | "multi-service";
    registry: string;
    healthPath: string;
    readinessPath?: string;
    containerPort?: number;
    ports?: Array<{
      name: string;
      containerPort: number;
      protocol: "tcp" | "udp";
    }>;
    signing?: {
      mode: "keyless";
      workflow: string;
      ref: string;
    };
    sbomFormat: "cyclonedx-json";
    sbomRetentionDays?: number;
    dependentServices?: Array<"postgres" | "redis">;
    runtimeEnvironment?: Record<string, string>;
    ephemeralEnvironment?: string[];
    migrationCommand?: string;
    testCommand?: string;
    deployment?: {
      environment: string;
      requireImmutableDigest: true;
      requireSignature: true;
      requireSbom: true;
      promotionMode?: ImagePromotionMode;
    };
  };
  dast?: null | {
    allowedOrigin: string;
    allowedOrigins?: string[];
    openapi: string;
    openapiSource?: "repository-file" | "live-endpoint";
    authenticationProfile: string;
    sessionAssertionPath: string;
    profiles?: {
      deploySmoke: DastScanProfile;
      nightly: DastScanProfile;
    };
    excludedRoutes?: string[];
  };
}

const SHA_PATTERN = /^[a-f0-9]{40}$/;
const ENVIRONMENT_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const SECRET_KEY_PATTERN =
  /(?:^|_)(?:SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE_KEY|CREDENTIAL|API_KEY)(?:_|$)/i;
const REPOSITORY_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REVIEW_CATEGORIES = new Set<ReviewCategory>([
  "security",
  "logic",
  "reliability",
  "concurrency",
  "performance",
  "contract",
  "testing",
  "maintainability"
]);
const DAST_PROFILES = new Set<DastScanProfile>([
  "baseline",
  "authenticated-baseline",
  "full",
  "authenticated-full"
]);
const IMAGE_PROMOTION_MODES = new Set<ImagePromotionMode>([
  "enforce-only",
  "verified-default-branch"
]);
const BRANCH_PATTERN = /^(?!\/)(?!.*(?:\/\/|\.\.|@\{))[^\s~^:?*[\\]+(?<![/.])$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function unknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  prefix: string,
  errors: string[]
): void {
  const allowlist = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowlist.has(key)) errors.push(`${prefix}.${key} is not supported`);
  }
}

function stringArray(
  value: unknown,
  path: string,
  errors: string[],
  options: {
    required?: boolean;
    validate?: (entry: string) => boolean;
  } = {}
): string[] {
  if (value === undefined && !options.required) return [];
  if (!Array.isArray(value)) {
    errors.push(`${path} must be an array`);
    return [];
  }
  const result: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (
      typeof entry !== "string" ||
      !entry.trim() ||
      entry.length > 1_000 ||
      /[\0\r\n]/.test(entry)
    ) {
      errors.push(`${path}[${index}] must be a non-empty single-line string`);
      continue;
    }
    if (options.validate && !options.validate(entry)) {
      errors.push(`${path}[${index}] is invalid`);
      continue;
    }
    result.push(entry);
  }
  if (new Set(result).size !== result.length) errors.push(`${path} must not contain duplicates`);
  return result;
}

function safeRepositoryPath(value: string): boolean {
  return (
    Boolean(value) &&
    value.length <= 1_000 &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !/^[A-Za-z]:[\\/]/.test(value) &&
    !/[\0\r\n]/.test(value) &&
    !value.split(/[\\/]/).some((segment) => segment === "..")
  );
}

function safeRequestPath(value: string): boolean {
  return /^\/(?!\/)[^\s?#]*(?:\?[^#\s]*)?$/.test(value);
}

function safeCommand(value: string): boolean {
  return Boolean(value.trim()) && value.length <= 1_000 && !/[\0\r\n]/.test(value);
}

function exactHttpsOrigin(value: string): URL | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function validateStringMap(
  value: unknown,
  path: string,
  errors: string[],
  options: { rejectSecretKeys?: boolean } = {}
): Record<string, string> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    errors.push(`${path} must be an object`);
    return {};
  }
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!ENVIRONMENT_KEY_PATTERN.test(key)) {
      errors.push(`${path} contains invalid key ${key}`);
      continue;
    }
    if (options.rejectSecretKeys && SECRET_KEY_PATTERN.test(key)) {
      errors.push(`${path}.${key} is secret-like and must use a control-plane reference`);
      continue;
    }
    if (typeof entry !== "string" || entry.length > 2_000 || /[\0\r\n]/.test(entry)) {
      errors.push(`${path}.${key} must be a single-line string`);
      continue;
    }
    result[key] = entry;
  }
  return result;
}

export function validateGuardianConfig(config: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(config)) return ["configuration must be an object"];
  unknownFields(
    config,
    ["schemaVersion", "workflowVersion", "repository", "paths", "review", "runner", "scanners", "image", "dast"],
    "configuration",
    errors
  );

  if (config.schemaVersion !== "1.0.0") errors.push("schemaVersion must be 1.0.0");
  if (typeof config.workflowVersion !== "string" || !SHA_PATTERN.test(config.workflowVersion)) {
    errors.push("workflowVersion must be an immutable 40-character commit SHA");
  }

  if (!isRecord(config.repository)) {
    errors.push("repository is required");
  } else {
    unknownFields(
      config.repository,
      [
        "defaultBranch",
        "releaseBranches",
        "languages",
        "packageManagers",
        "lockfiles",
        "codeowners",
        "relatedRepositories"
      ],
      "repository",
      errors
    );
    if (typeof config.repository.defaultBranch !== "string" || !config.repository.defaultBranch) {
      errors.push("defaultBranch is required");
    }
    stringArray(config.repository.releaseBranches, "repository.releaseBranches", errors, {
      required: true,
      validate: (entry) => BRANCH_PATTERN.test(entry)
    });
    stringArray(config.repository.languages, "repository.languages", errors, { required: true });
    stringArray(config.repository.packageManagers, "repository.packageManagers", errors);
    stringArray(config.repository.lockfiles, "repository.lockfiles", errors, {
      validate: safeRepositoryPath
    });
    if (
      config.repository.codeowners !== undefined &&
      (typeof config.repository.codeowners !== "string" ||
        !safeRepositoryPath(config.repository.codeowners))
    ) {
      errors.push("repository.codeowners must be a repository-relative path");
    }
    stringArray(
      config.repository.relatedRepositories,
      "repository.relatedRepositories",
      errors,
      { validate: (entry) => REPOSITORY_SLUG_PATTERN.test(entry) }
    );
  }

  if (config.paths !== undefined) {
    if (!isRecord(config.paths)) {
      errors.push("paths must be an object");
    } else {
      unknownFields(
        config.paths,
        ["source", "test", "generated", "vendored", "excluded"],
        "paths",
        errors
      );
      for (const key of ["source", "test", "generated", "vendored", "excluded"] as const) {
        stringArray(config.paths[key], `paths.${key}`, errors, {
          required: true,
          validate: safeRepositoryPath
        });
      }
    }
  }

  if (!isRecord(config.review)) {
    errors.push("review is required");
  } else {
    unknownFields(
      config.review,
      [
        "automatic",
        "drafts",
        "incremental",
        "manual",
        "targetBranches",
        "maxInlineComments",
        "categories",
        "highRiskPaths",
        "contextDocuments",
        "excludedPaths",
        "pathRules"
      ],
      "review",
      errors
    );
    if (typeof config.review.automatic !== "boolean") errors.push("review.automatic must be boolean");
    if (!["skip", "manual", "automatic"].includes(String(config.review.drafts))) {
      errors.push("review.drafts is invalid");
    }
    if (typeof config.review.incremental !== "boolean") {
      errors.push("review.incremental must be boolean");
    }
    if (config.review.manual !== undefined && typeof config.review.manual !== "boolean") {
      errors.push("review.manual must be boolean");
    }
    stringArray(config.review.targetBranches, "review.targetBranches", errors, {
      validate: (entry) => BRANCH_PATTERN.test(entry)
    });
    if (
      typeof config.review.maxInlineComments !== "number" ||
      !Number.isInteger(config.review.maxInlineComments) ||
      config.review.maxInlineComments < 0 ||
      config.review.maxInlineComments > 50
    ) {
      errors.push("maxInlineComments must be between 0 and 50");
    }
    const categories = stringArray(config.review.categories, "review.categories", errors, {
      required: true
    });
    for (const category of categories) {
      if (!REVIEW_CATEGORIES.has(category as ReviewCategory)) {
        errors.push(`review.categories contains unsupported category ${category}`);
      }
    }
    stringArray(config.review.highRiskPaths, "review.highRiskPaths", errors, {
      required: true,
      validate: safeRepositoryPath
    });
    stringArray(config.review.contextDocuments, "review.contextDocuments", errors, {
      validate: safeRepositoryPath
    });
    const excludedPaths = stringArray(
      config.review.excludedPaths,
      "review.excludedPaths",
      errors,
      { validate: safeRepositoryPath }
    );
    if (isRecord(config.paths) && excludedPaths.length) {
      const canonical = stringArray(config.paths.excluded, "paths.excluded", [], {
        validate: safeRepositoryPath
      });
      if (canonical.length && canonical.join("\0") !== excludedPaths.join("\0")) {
        errors.push("review.excludedPaths must match paths.excluded when both are configured");
      }
    }
    if (config.review.pathRules !== undefined) {
      if (!Array.isArray(config.review.pathRules)) {
        errors.push("review.pathRules must be an array");
      } else {
        const names = new Set<string>();
        for (const [index, rule] of config.review.pathRules.entries()) {
          const prefix = `review.pathRules[${index}]`;
          if (!isRecord(rule)) {
            errors.push(`${prefix} must be an object`);
            continue;
          }
          unknownFields(rule, ["name", "paths", "categories", "instructions"], prefix, errors);
          if (
            typeof rule.name !== "string" ||
            !rule.name.trim() ||
            rule.name.length > 100 ||
            /[\0\r\n]/.test(rule.name)
          ) {
            errors.push(`${prefix}.name must be a non-empty single-line string`);
          } else if (names.has(rule.name)) {
            errors.push(`review.pathRules contains duplicate name ${rule.name}`);
          } else {
            names.add(rule.name);
          }
          stringArray(rule.paths, `${prefix}.paths`, errors, {
            required: true,
            validate: safeRepositoryPath
          });
          const ruleCategories = stringArray(rule.categories, `${prefix}.categories`, errors);
          for (const category of ruleCategories) {
            if (!REVIEW_CATEGORIES.has(category as ReviewCategory)) {
              errors.push(`${prefix}.categories contains unsupported category ${category}`);
            }
          }
          stringArray(rule.instructions, `${prefix}.instructions`, errors, { required: true });
        }
      }
    }
  }

  if (config.runner !== undefined) {
    if (!isRecord(config.runner)) {
      errors.push("runner must be an object");
    } else {
      unknownFields(
        config.runner,
        ["executionEnvironment", "testCommands", "buildCommands"],
        "runner",
        errors
      );
      if (
        !["github-hosted", "ephemeral"].includes(
          String(config.runner.executionEnvironment)
        )
      ) {
        errors.push("runner.executionEnvironment is invalid");
      }
      stringArray(config.runner.testCommands, "runner.testCommands", errors, {
        required: true,
        validate: safeCommand
      });
      stringArray(config.runner.buildCommands, "runner.buildCommands", errors, {
        required: true,
        validate: safeCommand
      });
    }
  }

  if (!isRecord(config.scanners)) {
    errors.push("scanners is required");
  } else {
    unknownFields(config.scanners, ["mode", "semgrep", "trivy", "suppressions"], "scanners", errors);
    if (!["advisory", "report-only", "enforce"].includes(String(config.scanners.mode))) {
      errors.push("scanners.mode is invalid");
    }
    if (typeof config.scanners.semgrep !== "boolean") errors.push("scanners.semgrep must be boolean");
    if (typeof config.scanners.trivy !== "boolean") errors.push("scanners.trivy must be boolean");
    if (config.scanners.suppressions !== undefined) {
      if (!Array.isArray(config.scanners.suppressions)) {
        errors.push("scanners.suppressions must be an array");
      } else {
        for (const [index, suppression] of config.scanners.suppressions.entries()) {
          const prefix = `scanners.suppressions[${index}]`;
          if (!isRecord(suppression)) {
            errors.push(`${prefix} must be an object`);
            continue;
          }
          unknownFields(
            suppression,
            ["fingerprint", "owner", "reason", "ticket", "expiresAt"],
            prefix,
            errors
          );
          const fingerprint =
            typeof suppression.fingerprint === "string" ? suppression.fingerprint : `#${index}`;
          if (!fingerprint || fingerprint.length > 512 || /[\0\r\n]/.test(fingerprint)) {
            errors.push(`${prefix}.fingerprint is invalid`);
          }
          if (
            typeof suppression.expiresAt !== "string" ||
            Number.isNaN(Date.parse(suppression.expiresAt))
          ) {
            errors.push(`suppression ${fingerprint} has an invalid expiresAt`);
          }
          if (
            typeof suppression.owner !== "string" ||
            !suppression.owner ||
            typeof suppression.reason !== "string" ||
            !suppression.reason ||
            typeof suppression.ticket !== "string" ||
            !suppression.ticket
          ) {
            errors.push(`suppression ${fingerprint} is missing review metadata`);
          }
        }
      }
    }
  }

  if (config.image !== undefined && config.image !== null) {
    if (!isRecord(config.image)) {
      errors.push("image must be an object or null");
    } else {
      unknownFields(
        config.image,
        [
          "name",
          "dockerfile",
          "context",
          "platform",
          "buildArguments",
          "smokeProfile",
          "registry",
          "healthPath",
          "readinessPath",
          "containerPort",
          "ports",
          "signing",
          "sbomFormat",
          "sbomRetentionDays",
          "dependentServices",
          "runtimeEnvironment",
          "ephemeralEnvironment",
          "migrationCommand",
          "testCommand",
          "deployment"
        ],
        "image",
        errors
      );
      if (
        config.image.name !== undefined &&
        (typeof config.image.name !== "string" ||
          !/^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/.test(config.image.name))
      ) {
        errors.push("image.name must be a lowercase image name");
      }
      if (typeof config.image.dockerfile !== "string" || !safeRepositoryPath(config.image.dockerfile)) {
        errors.push("image.dockerfile must be a repository-relative path");
      }
      if (
        typeof config.image.context !== "string" ||
        (config.image.context !== "." && !safeRepositoryPath(config.image.context))
      ) {
        errors.push("image.context must be . or a repository-relative path");
      }
      if (config.image.platform !== "linux/amd64") {
        errors.push("image.platform must be linux/amd64");
      }
      const buildArguments = validateStringMap(
        config.image.buildArguments,
        "image.buildArguments",
        errors,
        { rejectSecretKeys: true }
      );
      if (
        config.image.smokeProfile !== undefined &&
        !["http", "command", "multi-service"].includes(String(config.image.smokeProfile))
      ) {
        errors.push("image.smokeProfile is invalid");
      }
      if (
        typeof config.image.registry !== "string" ||
        !/^ghcr\.io\/[a-z0-9._-]+\/[a-z0-9._/-]+$/.test(config.image.registry)
      ) {
        errors.push("image.registry must be a lowercase GHCR repository path");
      }
      if (typeof config.image.healthPath !== "string" || !safeRequestPath(config.image.healthPath)) {
        errors.push("image.healthPath must be an origin-relative path");
      }
      if (
        config.image.readinessPath !== undefined &&
        (typeof config.image.readinessPath !== "string" ||
          !safeRequestPath(config.image.readinessPath))
      ) {
        errors.push("image.readinessPath must be an origin-relative path");
      }
      if (
        config.image.containerPort !== undefined &&
        (typeof config.image.containerPort !== "number" ||
          !Number.isInteger(config.image.containerPort) ||
          config.image.containerPort < 1 ||
          config.image.containerPort > 65_535)
      ) {
        errors.push("image.containerPort must be between 1 and 65535");
      }
      if (config.image.ports !== undefined) {
        if (!Array.isArray(config.image.ports)) {
          errors.push("image.ports must be an array");
        } else {
          const names = new Set<string>();
          for (const [index, port] of config.image.ports.entries()) {
            const prefix = `image.ports[${index}]`;
            if (!isRecord(port)) {
              errors.push(`${prefix} must be an object`);
              continue;
            }
            unknownFields(port, ["name", "containerPort", "protocol"], prefix, errors);
            if (
              typeof port.name !== "string" ||
              !/^[a-z][a-z0-9-]{0,31}$/.test(port.name)
            ) {
              errors.push(`${prefix}.name is invalid`);
            } else if (names.has(port.name)) {
              errors.push(`image.ports contains duplicate name ${port.name}`);
            } else {
              names.add(port.name);
            }
            if (
              typeof port.containerPort !== "number" ||
              !Number.isInteger(port.containerPort) ||
              port.containerPort < 1 ||
              port.containerPort > 65_535
            ) {
              errors.push(`${prefix}.containerPort must be between 1 and 65535`);
            }
            if (!["tcp", "udp"].includes(String(port.protocol))) {
              errors.push(`${prefix}.protocol must be tcp or udp`);
            }
          }
        }
      }
      if (config.image.signing !== undefined) {
        if (!isRecord(config.image.signing)) {
          errors.push("image.signing must be an object");
        } else {
          unknownFields(config.image.signing, ["mode", "workflow", "ref"], "image.signing", errors);
          if (config.image.signing.mode !== "keyless") {
            errors.push("image.signing.mode must be keyless");
          }
          if (
            typeof config.image.signing.workflow !== "string" ||
            !safeRepositoryPath(config.image.signing.workflow) ||
            !config.image.signing.workflow.startsWith(".github/workflows/")
          ) {
            errors.push("image.signing.workflow must be a repository workflow path");
          }
          if (
            typeof config.image.signing.ref !== "string" ||
            !/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/.test(config.image.signing.ref) ||
            config.image.signing.ref.includes("..") ||
            config.image.signing.ref.includes("//") ||
            config.image.signing.ref.endsWith(".") ||
            config.image.signing.ref.endsWith("/")
          ) {
            errors.push("image.signing.ref must be an exact branch or tag ref");
          }
        }
      }
      if (config.image.sbomFormat !== "cyclonedx-json") {
        errors.push("image.sbomFormat must be cyclonedx-json");
      }
      if (
        config.image.sbomRetentionDays !== undefined &&
        (typeof config.image.sbomRetentionDays !== "number" ||
          !Number.isInteger(config.image.sbomRetentionDays) ||
          config.image.sbomRetentionDays < 1 ||
          config.image.sbomRetentionDays > 3_650)
      ) {
        errors.push("image.sbomRetentionDays must be between 1 and 3650");
      }
      const dependentServices = stringArray(
        config.image.dependentServices,
        "image.dependentServices",
        errors
      );
      for (const service of dependentServices) {
        if (!["postgres", "redis"].includes(service)) {
          errors.push(`image.dependentServices contains unsupported service ${service}`);
        }
      }
      const runtimeEnvironment = validateStringMap(
        config.image.runtimeEnvironment,
        "image.runtimeEnvironment",
        errors,
        { rejectSecretKeys: true }
      );
      const ephemeralEnvironment = stringArray(
        config.image.ephemeralEnvironment,
        "image.ephemeralEnvironment",
        errors,
        { validate: (key) => ENVIRONMENT_KEY_PATTERN.test(key) }
      );
      for (const key of ephemeralEnvironment) {
        if (runtimeEnvironment[key] !== undefined || buildArguments[key] !== undefined) {
          errors.push(`image ephemeral key ${key} must not also have a static value`);
        }
      }
      for (const [key, value] of [
        ["migrationCommand", config.image.migrationCommand],
        ["testCommand", config.image.testCommand]
      ] as const) {
        if (value !== undefined && (typeof value !== "string" || !safeCommand(value))) {
          errors.push(`image.${key} must be a non-empty single-line command`);
        }
      }
      if (config.image.deployment !== undefined) {
        if (!isRecord(config.image.deployment)) {
          errors.push("image.deployment must be an object");
        } else {
          unknownFields(
            config.image.deployment,
            [
              "environment",
              "requireImmutableDigest",
              "requireSignature",
              "requireSbom",
              "promotionMode"
            ],
            "image.deployment",
            errors
          );
          if (
            typeof config.image.deployment.environment !== "string" ||
            !/^[a-z][a-z0-9-]{0,62}$/.test(config.image.deployment.environment)
          ) {
            errors.push("image.deployment.environment is invalid");
          }
          for (const key of [
            "requireImmutableDigest",
            "requireSignature",
            "requireSbom"
          ] as const) {
            if (config.image.deployment[key] !== true) {
              errors.push(`image.deployment.${key} must be true`);
            }
          }
          if (
            config.image.deployment.promotionMode !== undefined &&
            !IMAGE_PROMOTION_MODES.has(
              config.image.deployment.promotionMode as ImagePromotionMode
            )
          ) {
            errors.push("image.deployment.promotionMode is invalid");
          }
        }
      }
    }
  }

  if (config.dast !== undefined && config.dast !== null) {
    if (!isRecord(config.dast)) {
      errors.push("dast must be an object or null");
    } else {
      unknownFields(
        config.dast,
        [
          "allowedOrigin",
          "allowedOrigins",
          "openapi",
          "openapiSource",
          "authenticationProfile",
          "sessionAssertionPath",
          "profiles",
          "excludedRoutes"
        ],
        "dast",
        errors
      );
      const origin =
        typeof config.dast.allowedOrigin === "string"
          ? exactHttpsOrigin(config.dast.allowedOrigin)
          : undefined;
      if (!origin) errors.push("dast.allowedOrigin must be an exact HTTPS origin");
      const origins = stringArray(config.dast.allowedOrigins, "dast.allowedOrigins", errors, {
        validate: (entry) => Boolean(exactHttpsOrigin(entry))
      });
      if (origins.length && typeof config.dast.allowedOrigin === "string") {
        if (!origins.includes(config.dast.allowedOrigin)) {
          errors.push("dast.allowedOrigins must include dast.allowedOrigin");
        }
      }
      const sessionAssertionInvalid =
        typeof config.dast.sessionAssertionPath !== "string" ||
        !safeRequestPath(config.dast.sessionAssertionPath);
      if (sessionAssertionInvalid) {
        errors.push("dast.sessionAssertionPath must begin with '/'");
      }
      if (
        config.dast.openapiSource !== undefined &&
        !["repository-file", "live-endpoint"].includes(String(config.dast.openapiSource))
      ) {
        errors.push("dast.openapiSource is invalid");
      }
      if (typeof config.dast.openapi !== "string" || !config.dast.openapi) {
        errors.push("dast.openapi is required");
      } else {
        const source =
          config.dast.openapiSource ??
          (config.dast.openapi.startsWith("/") || /^https:/i.test(config.dast.openapi)
            ? "live-endpoint"
            : "repository-file");
        if (source === "repository-file") {
          if (
            !safeRepositoryPath(config.dast.openapi) ||
            !/\.(?:json|ya?ml)$/i.test(config.dast.openapi)
          ) {
            errors.push("dast.openapi repository file must be a JSON or YAML repository path");
          }
        } else if (origin) {
          try {
            const openapiUrl = new URL(config.dast.openapi, origin);
            if (openapiUrl.protocol !== "https:") {
              errors.push("dast.openapi live endpoint must resolve to HTTPS");
            }
            if (openapiUrl.origin !== origin.origin) {
              errors.push("dast.openapi must resolve to the same origin as dast.allowedOrigin");
            }
          } catch {
            errors.push("dast.openapi live endpoint must be a relative path or absolute URL");
          }
        }
      }
      // Report the opaque-reference error once the structural DAST target is
      // valid. This keeps diagnostics actionable while every invalid
      // configuration still fails closed.
      const targetHasStructuralError =
        !origin ||
        sessionAssertionInvalid ||
        errors.some((error) => error.startsWith("dast.openapi"));
      if (
        !targetHasStructuralError &&
        (typeof config.dast.authenticationProfile !== "string" ||
          !/^control-plane:\/\/profiles\/[A-Za-z0-9._/-]+$/.test(
            config.dast.authenticationProfile
          ) ||
          config.dast.authenticationProfile.includes(".."))
      ) {
        errors.push("dast.authenticationProfile must be an opaque control-plane profile reference");
      }
      if (config.dast.profiles !== undefined) {
        if (!isRecord(config.dast.profiles)) {
          errors.push("dast.profiles must be an object");
        } else {
          unknownFields(config.dast.profiles, ["deploySmoke", "nightly"], "dast.profiles", errors);
          for (const key of ["deploySmoke", "nightly"] as const) {
            if (!DAST_PROFILES.has(config.dast.profiles[key] as DastScanProfile)) {
              errors.push(`dast.profiles.${key} is invalid`);
            }
          }
        }
      }
      stringArray(config.dast.excludedRoutes, "dast.excludedRoutes", errors, {
        validate: safeRequestPath
      });
    }
  }
  return errors;
}

export function parseGuardianConfigDocument(source: string): unknown {
  return YAML.parse(source) as unknown;
}

export function parseGuardianConfig(source: string): GuardianConfig {
  const value = parseGuardianConfigDocument(source);
  const errors = validateGuardianConfig(value);
  if (errors.length) throw new Error(`Invalid GuardianBot configuration:\n${errors.join("\n")}`);
  return value as GuardianConfig;
}

export function serializeGuardianConfig(config: GuardianConfig): string {
  return YAML.stringify(config, { lineWidth: 100 });
}

export function validateAgainstJsonSchema(
  schema: object,
  value: unknown
): string[] {
  const Ajv = Ajv2020Import as unknown as new (options?: Options) => AjvInstance;
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
