const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 250;
const MAX_RESPONSE_BODY_PREVIEW = 1_024;
const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

export interface DefectDojoConfigRefs {
  baseUrlRef: string;
  apiTokenRef: string;
  userAgent?: string;
  timeoutMs?: number;
  pageSize?: number;
  maxAttempts?: number;
  backoffMs?: number;
  dryRun?: boolean;
}

export interface DefectDojoResolvedConfig {
  readonly baseUrl: string;
  readonly apiToken: string;
  readonly userAgent: string;
  readonly timeoutMs: number;
  readonly pageSize: number;
  readonly maxAttempts: number;
  readonly backoffMs: number;
  readonly dryRun: boolean;
  readonly refs: {
    baseUrlRef: string;
    apiTokenRef: string;
  };
}

export interface DefectDojoProductType {
  id: number;
  name: string;
  description?: string | null;
}

export interface DefectDojoProduct {
  id: number;
  name: string;
  description?: string | null;
  prod_type?: number | null;
  tags?: string[];
}

export interface DefectDojoEngagement {
  id: number;
  name: string;
  product: number;
  status?: string | null;
  target_start?: string | null;
  target_end?: string | null;
  branch_tag?: string | null;
  build_id?: string | null;
  commit_hash?: string | null;
  version?: string | null;
  tags?: string[];
}

export interface DefectDojoTest {
  id: number;
  engagement: number;
  scan_type?: string | null;
  title?: string | null;
  version?: string | null;
  branch_tag?: string | null;
  build_id?: string | null;
  commit_hash?: string | null;
  tags?: string[];
  updated?: string | null;
  created?: string | null;
}

export interface DefectDojoImportMetadata {
  version?: string;
  buildId?: string;
  branchTag?: string;
  commitHash?: string;
  scanDate?: string;
  tags?: string[];
  minimumSeverity?: "Info" | "Low" | "Medium" | "High" | "Critical";
  closeOldFindings?: boolean;
  doNotReactivate?: boolean;
  active?: boolean;
  verified?: boolean;
  environment?: string;
}

export interface DefectDojoScanIdentity {
  repositoryId: number;
  repositorySlug: string;
  visibility: "public" | "private" | "internal";
  commitSha: string;
  workflowRunId: string;
  workflowAttempt?: string;
  branch: string;
  profile: string;
  scanType: string;
  environment?: string;
  imageDigest?: string;
  customTags?: string[];
}

export interface DefectDojoProductTypeInput {
  name: string;
  description?: string;
}

export interface DefectDojoProductInput {
  productTypeId: number;
  name: string;
  description?: string;
  tags?: string[];
}

export interface DefectDojoEngagementInput {
  productId: number;
  name: string;
  status?: string;
  targetStart?: string;
  targetEnd?: string;
  branchTag?: string;
  buildId?: string;
  commitHash?: string;
  version?: string;
  tags?: string[];
}

export interface DefectDojoTestInput {
  engagementId: number;
  scanType: string;
  title: string;
  version?: string;
  branchTag?: string;
  buildId?: string;
  commitHash?: string;
  tags?: string[];
}

export interface DefectDojoEnsureImportContextInput {
  productType: DefectDojoProductTypeInput;
  product: Omit<DefectDojoProductInput, "productTypeId">;
  engagement: Omit<DefectDojoEngagementInput, "productId">;
  test: DefectDojoTestInput;
}

export interface DefectDojoEnsureImportContextResult {
  productType: DefectDojoProductType;
  product: DefectDojoProduct;
  engagement: DefectDojoEngagement;
  test: DefectDojoTest | null;
}

export interface DefectDojoImportScanInput {
  scanType: string;
  testTitle: string;
  fileName: string;
  contentType: string;
  report: Uint8Array;
  engagementId: number;
  existingTestId?: number | null;
  metadata?: DefectDojoImportMetadata;
}

export interface DefectDojoImportResult {
  mode: "import" | "reimport";
  response: unknown;
  testId?: number | null;
}

export interface DefectDojoDryRunOperation {
  dryRun: true;
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: Record<string, unknown>;
  notes?: string[];
}

export interface DefectDojoClientOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

export class DefectDojoError extends Error {
  readonly kind: "config" | "http" | "network" | "timeout" | "validation";
  readonly path: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly requestId?: string;
  readonly details?: string;

  constructor(input: {
    kind: "config" | "http" | "network" | "timeout" | "validation";
    path: string;
    message: string;
    status?: number;
    retryable?: boolean;
    requestId?: string;
    details?: string;
    cause?: unknown;
  }) {
    super(input.message, input.cause ? { cause: input.cause } : undefined);
    this.name = "DefectDojoError";
    this.kind = input.kind;
    this.path = input.path;
    this.status = input.status;
    this.retryable = input.retryable ?? false;
    this.requestId = input.requestId;
    this.details = input.details;
  }
}

interface DefectDojoRequest<T> {
  method: "GET" | "POST" | "PATCH";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  body?: BodyInit | null;
  json?: Record<string, unknown>;
  expectJson?: boolean;
  idempotencyKey?: string;
  timeoutMs?: number;
}

interface DefectDojoPage<T> {
  count?: number;
  next?: string | null;
  previous?: string | null;
  results?: T[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isDryRunOperation(value: unknown): value is DefectDojoDryRunOperation {
  return (
    isRecord(value) &&
    value.dryRun === true &&
    typeof value.method === "string" &&
    typeof value.path === "string"
  );
}

function sortStrings(values: string[] | undefined): string[] | undefined {
  if (!values?.length) {
    return undefined;
  }
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function normalizeDate(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new DefectDojoError({
      kind: "validation",
      path: "config",
      message: `invalid ISO date '${value}'`
    });
  }
  return value;
}

function truncateBody(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length > MAX_RESPONSE_BODY_PREVIEW
    ? `${trimmed.slice(0, MAX_RESPONSE_BODY_PREVIEW)}...`
    : trimmed;
}

function parseRetryAfter(value: string | null, now: Date): number | null {
  if (!value) {
    return null;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const retryAt = Date.parse(value);
  if (Number.isNaN(retryAt)) {
    return null;
  }
  return Math.max(0, retryAt - now.getTime());
}

function stableArrayEqual(left: string[] | undefined, right: string[] | undefined): boolean {
  const leftSorted = sortStrings(left) ?? [];
  const rightSorted = sortStrings(right) ?? [];
  return leftSorted.length === rightSorted.length &&
    leftSorted.every((value, index) => value === rightSorted[index]);
}

function maybeSet(
  payload: Record<string, unknown>,
  key: string,
  value: string | number | boolean | undefined
): void {
  if (value !== undefined) {
    payload[key] = value;
  }
}

function latestTest(left: DefectDojoTest, right: DefectDojoTest): DefectDojoTest {
  const leftTime = Date.parse(left.updated ?? left.created ?? "");
  const rightTime = Date.parse(right.updated ?? right.created ?? "");
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime > rightTime ? left : right;
  }
  return left.id > right.id ? left : right;
}

export function resolveDefectDojoConfig(
  env: Record<string, string | undefined>,
  refs: DefectDojoConfigRefs
): DefectDojoResolvedConfig {
  const baseUrl = env[refs.baseUrlRef];
  const apiToken = env[refs.apiTokenRef];
  if (!baseUrl) {
    throw new DefectDojoError({
      kind: "config",
      path: refs.baseUrlRef,
      message: `missing required DefectDojo base URL environment reference ${refs.baseUrlRef}`
    });
  }
  if (!apiToken) {
    throw new DefectDojoError({
      kind: "config",
      path: refs.apiTokenRef,
      message: `missing required DefectDojo API token environment reference ${refs.apiTokenRef}`
    });
  }
  return {
    baseUrl: normalizeBaseUrl(baseUrl),
    apiToken,
    userAgent: refs.userAgent ?? "@guardianbot/defectdojo",
    timeoutMs: refs.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    pageSize: refs.pageSize ?? DEFAULT_PAGE_SIZE,
    maxAttempts: refs.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    backoffMs: refs.backoffMs ?? DEFAULT_BACKOFF_MS,
    dryRun: refs.dryRun ?? false,
    refs: {
      baseUrlRef: refs.baseUrlRef,
      apiTokenRef: refs.apiTokenRef
    }
  };
}

export function buildDefectDojoTags(identity: DefectDojoScanIdentity): string[] {
  const tags = [
    `guardianbot:repo-id:${identity.repositoryId}`,
    `guardianbot:repo:${identity.repositorySlug.toLowerCase()}`,
    `guardianbot:visibility:${identity.visibility}`,
    `guardianbot:commit:${identity.commitSha}`,
    `guardianbot:run:${identity.workflowRunId}`,
    `guardianbot:branch:${identity.branch}`,
    `guardianbot:profile:${identity.profile}`,
    `guardianbot:scan:${identity.scanType}`,
    identity.workflowAttempt ? `guardianbot:attempt:${identity.workflowAttempt}` : undefined,
    identity.environment ? `guardianbot:env:${identity.environment}` : undefined,
    identity.imageDigest ? `guardianbot:image:${identity.imageDigest}` : undefined,
    ...(identity.customTags ?? [])
  ].filter((value): value is string => Boolean(value));
  return sortStrings(tags) ?? [];
}

export function buildImmutableScanIdentity(identity: DefectDojoScanIdentity): string {
  return [
    identity.repositoryId,
    identity.repositorySlug.toLowerCase(),
    identity.visibility,
    identity.branch,
    identity.profile,
    identity.scanType,
    identity.workflowRunId,
    identity.workflowAttempt ?? "",
    identity.commitSha,
    identity.environment ?? "",
    identity.imageDigest ?? ""
  ].join("|");
}

export class DefectDojoClient {
  private readonly fetchImpl: typeof fetch;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly now: () => Date;

  constructor(
    private readonly config: DefectDojoResolvedConfig,
    options: DefectDojoClientOptions = {}
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.sleepImpl = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? (() => new Date());
  }

  async listProducts(query: Record<string, string | number | boolean | undefined> = {}) {
    return this.listPaginated<DefectDojoProduct>("/api/v2/products/", query);
  }

  async listEngagements(query: Record<string, string | number | boolean | undefined> = {}) {
    return this.listPaginated<DefectDojoEngagement>("/api/v2/engagements/", query);
  }

  async listTests(query: Record<string, string | number | boolean | undefined> = {}) {
    return this.listPaginated<DefectDojoTest>("/api/v2/tests/", query);
  }

  async ensureProductType(
    input: DefectDojoProductTypeInput
  ): Promise<DefectDojoProductType | DefectDojoDryRunOperation> {
    const existing = await this.findByName<DefectDojoProductType>("/api/v2/product_types/", input.name);
    const payload = { name: input.name, description: input.description ?? "" };
    if (!existing) {
      return this.createJson("/api/v2/product_types/", payload, `product-type:${input.name}`);
    }
    if ((existing.description ?? "") !== payload.description) {
      return this.patchJson(
        `/api/v2/product_types/${existing.id}/`,
        { description: payload.description },
        `product-type:${existing.id}`
      );
    }
    return existing;
  }

  async ensureProduct(
    input: DefectDojoProductInput
  ): Promise<DefectDojoProduct | DefectDojoDryRunOperation> {
    const candidates = await this.listProducts({ name: input.name, prod_type: input.productTypeId });
    const existing = candidates.find(
      (product) => product.name === input.name && product.prod_type === input.productTypeId
    );
    const tags = sortStrings(input.tags);
    const payload: Record<string, unknown> = {
      name: input.name,
      description: input.description ?? "",
      prod_type: input.productTypeId
    };
    if (tags?.length) {
      payload.tags = tags;
    }
    if (!existing) {
      return this.createJson("/api/v2/products/", payload, `product:${input.productTypeId}:${input.name}`);
    }
    const patch: Record<string, unknown> = {};
    if ((existing.description ?? "") !== (input.description ?? "")) {
      patch.description = input.description ?? "";
    }
    if (existing.prod_type !== input.productTypeId) {
      patch.prod_type = input.productTypeId;
    }
    if (!stableArrayEqual(existing.tags, tags)) {
      patch.tags = tags ?? [];
    }
    if (!Object.keys(patch).length) {
      return existing;
    }
    return this.patchJson(`/api/v2/products/${existing.id}/`, patch, `product:${existing.id}`);
  }

  async ensureEngagement(
    input: DefectDojoEngagementInput
  ): Promise<DefectDojoEngagement | DefectDojoDryRunOperation> {
    const candidates = await this.listEngagements({ product: input.productId, name: input.name });
    const existing = candidates.find(
      (engagement) => engagement.product === input.productId && engagement.name === input.name
    );
    const tags = sortStrings(input.tags);
    const payload: Record<string, unknown> = {
      product: input.productId,
      name: input.name
    };
    maybeSet(payload, "status", input.status);
    maybeSet(payload, "target_start", normalizeDate(input.targetStart));
    maybeSet(payload, "target_end", normalizeDate(input.targetEnd));
    maybeSet(payload, "branch_tag", input.branchTag);
    maybeSet(payload, "build_id", input.buildId);
    maybeSet(payload, "commit_hash", input.commitHash);
    maybeSet(payload, "version", input.version);
    if (tags?.length) {
      payload.tags = tags;
    }
    if (!existing) {
      return this.createJson(
        "/api/v2/engagements/",
        payload,
        `engagement:${input.productId}:${input.name}`
      );
    }
    const patch: Record<string, unknown> = {};
    const mappings: Array<[keyof DefectDojoEngagement, string, string | undefined]> = [
      ["status", "status", input.status],
      ["target_start", "target_start", normalizeDate(input.targetStart)],
      ["target_end", "target_end", normalizeDate(input.targetEnd)],
      ["branch_tag", "branch_tag", input.branchTag],
      ["build_id", "build_id", input.buildId],
      ["commit_hash", "commit_hash", input.commitHash],
      ["version", "version", input.version]
    ];
    for (const [currentKey, patchKey, nextValue] of mappings) {
      if ((existing[currentKey] ?? undefined) !== nextValue) {
        maybeSet(patch, patchKey, nextValue);
      }
    }
    if (!stableArrayEqual(existing.tags, tags)) {
      patch.tags = tags ?? [];
    }
    if (!Object.keys(patch).length) {
      return existing;
    }
    return this.patchJson(`/api/v2/engagements/${existing.id}/`, patch, `engagement:${existing.id}`);
  }

  async ensureTest(
    input: DefectDojoTestInput
  ): Promise<DefectDojoTest | DefectDojoDryRunOperation> {
    const existing = await this.findLatestTest({
      engagementId: input.engagementId,
      scanType: input.scanType,
      title: input.title
    });
    const tags = sortStrings(input.tags);
    const payload: Record<string, unknown> = {
      engagement: input.engagementId,
      scan_type: input.scanType,
      title: input.title
    };
    maybeSet(payload, "version", input.version);
    maybeSet(payload, "branch_tag", input.branchTag);
    maybeSet(payload, "build_id", input.buildId);
    maybeSet(payload, "commit_hash", input.commitHash);
    if (tags?.length) {
      payload.tags = tags;
    }
    if (!existing) {
      return this.createJson("/api/v2/tests/", payload, `test:${input.engagementId}:${input.scanType}:${input.title}`);
    }
    const patch: Record<string, unknown> = {};
    const mappings: Array<[keyof DefectDojoTest, string, string | undefined]> = [
      ["title", "title", input.title],
      ["version", "version", input.version],
      ["branch_tag", "branch_tag", input.branchTag],
      ["build_id", "build_id", input.buildId],
      ["commit_hash", "commit_hash", input.commitHash]
    ];
    for (const [currentKey, patchKey, nextValue] of mappings) {
      if ((existing[currentKey] ?? undefined) !== nextValue) {
        maybeSet(patch, patchKey, nextValue);
      }
    }
    if (!stableArrayEqual(existing.tags, tags)) {
      patch.tags = tags ?? [];
    }
    if (!Object.keys(patch).length) {
      return existing;
    }
    return this.patchJson(`/api/v2/tests/${existing.id}/`, patch, `test:${existing.id}`);
  }

  async ensureImportContext(
    input: DefectDojoEnsureImportContextInput
  ): Promise<DefectDojoEnsureImportContextResult | DefectDojoDryRunOperation[]> {
    const productType = await this.ensureProductType(input.productType);
    if ("dryRun" in productType) {
      return [productType];
    }
    const product = await this.ensureProduct({
      ...input.product,
      productTypeId: productType.id
    });
    if ("dryRun" in product) {
      return [productTypeToDryRun(productType), product];
    }
    const engagement = await this.ensureEngagement({
      ...input.engagement,
      productId: product.id
    });
    if ("dryRun" in engagement) {
      return [productTypeToDryRun(productType), productToDryRun(product), engagement];
    }
    const test = await this.ensureTest({
      ...input.test,
      engagementId: engagement.id
    });
    if ("dryRun" in test) {
      return [
        productTypeToDryRun(productType),
        productToDryRun(product),
        engagementToDryRun(engagement),
        test
      ];
    }
    return {
      productType,
      product,
      engagement,
      test
    };
  }

  async findLatestTest(input: {
    engagementId: number;
    scanType: string;
    title?: string;
  }): Promise<DefectDojoTest | null> {
    const tests = await this.listTests({
      engagement: input.engagementId,
      scan_type: input.scanType,
      title: input.title
    });
    const matches = tests.filter(
      (test) =>
        test.engagement === input.engagementId &&
        test.scan_type === input.scanType &&
        (input.title ? test.title === input.title : true)
    );
    if (!matches.length) {
      return null;
    }
    return matches.reduce(latestTest);
  }

  async importScan(
    input: DefectDojoImportScanInput
  ): Promise<DefectDojoImportResult | DefectDojoDryRunOperation> {
    const mode = input.existingTestId ? "reimport" : "import";
    const endpoint = mode === "reimport" ? "/api/v2/reimport-scan/" : "/api/v2/import-scan/";
    const form = new FormData();
    form.set("scan_type", input.scanType);
    form.set("test_title", input.testTitle);
    form.set(
      "file",
      new Blob([input.report.slice().buffer as ArrayBuffer], { type: input.contentType }),
      input.fileName
    );
    if (mode === "reimport") {
      form.set("test", String(input.existingTestId));
    } else {
      form.set("engagement", String(input.engagementId));
    }
    form.set("close_old_findings", String(input.metadata?.closeOldFindings ?? true));
    form.set("do_not_reactivate", String(input.metadata?.doNotReactivate ?? false));
    form.set("active", String(input.metadata?.active ?? true));
    form.set("verified", String(input.metadata?.verified ?? true));
    if (input.metadata?.minimumSeverity) {
      form.set("minimum_severity", input.metadata.minimumSeverity);
    }
    if (input.metadata?.version) {
      form.set("version", input.metadata.version);
    }
    if (input.metadata?.buildId) {
      form.set("build_id", input.metadata.buildId);
    }
    if (input.metadata?.branchTag) {
      form.set("branch_tag", input.metadata.branchTag);
    }
    if (input.metadata?.commitHash) {
      form.set("commit_hash", input.metadata.commitHash);
    }
    if (input.metadata?.environment) {
      form.set("environment", input.metadata.environment);
    }
    if (input.metadata?.scanDate) {
      const scanDate = normalizeDate(input.metadata.scanDate);
      if (scanDate) {
        form.set("scan_date", scanDate);
      }
    }
    for (const tag of sortStrings(input.metadata?.tags) ?? []) {
      form.append("tags", tag);
    }
    const idempotencyKey = [
      mode,
      input.scanType,
      input.testTitle,
      input.engagementId,
      input.existingTestId ?? "",
      input.metadata?.commitHash ?? "",
      input.metadata?.buildId ?? ""
    ].join(":");
    const result = await this.request<unknown>({
      method: "POST",
      path: endpoint,
      body: form,
      expectJson: true,
      idempotencyKey
    });
    if (isDryRunOperation(result)) {
      return result;
    }
    const maybeResponse = isRecord(result) ? result : {};
    const testId =
      typeof maybeResponse.test === "number"
        ? maybeResponse.test
        : typeof maybeResponse.test_id === "number"
          ? maybeResponse.test_id
          : input.existingTestId ?? null;
    return { mode, response: result, testId };
  }

  async findByName<T extends { name?: string }>(path: string, name: string): Promise<T | null> {
    const results = await this.listPaginated<T>(path, { name });
    return results.find((item) => item.name === name) ?? null;
  }

  private async listPaginated<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {}
  ): Promise<T[]> {
    const results: T[] = [];
    let nextPath: string | null = path;
    let nextQuery: Record<string, string | number | boolean | undefined> | undefined = {
      ...query,
      limit: query.limit ?? this.config.pageSize
    };
    while (nextPath) {
      const pageResult: DefectDojoPage<T> | T[] | DefectDojoDryRunOperation = await this.request<
        DefectDojoPage<T> | T[]
      >({
        method: "GET",
        path: nextPath,
        query: nextQuery,
        expectJson: true
      });
      if (isDryRunOperation(pageResult)) {
        throw new DefectDojoError({
          kind: "validation",
          path,
          message: "dry-run mode is not supported for paginated reads"
        });
      }
      const page: DefectDojoPage<T> | T[] = pageResult;
      if (Array.isArray(page)) {
        results.push(...page);
        break;
      }
      results.push(...(page.results ?? []));
      nextPath = page.next ?? null;
      nextQuery = undefined;
    }
    return results;
  }

  private async createJson<T>(
    path: string,
    json: Record<string, unknown>,
    idempotencyKey: string
  ): Promise<T | DefectDojoDryRunOperation> {
    return this.request<T>({
      method: "POST",
      path,
      json,
      expectJson: true,
      idempotencyKey
    });
  }

  private async patchJson<T>(
    path: string,
    json: Record<string, unknown>,
    idempotencyKey: string
  ): Promise<T | DefectDojoDryRunOperation> {
    return this.request<T>({
      method: "PATCH",
      path,
      json,
      expectJson: true,
      idempotencyKey
    });
  }

  private async request<T>(
    input: DefectDojoRequest<T>
  ): Promise<T | DefectDojoDryRunOperation> {
    const url = new URL(input.path, this.config.baseUrl);
    if (input.query) {
      for (const [key, value] of Object.entries(input.query)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    const headers = new Headers(input.headers);
    headers.set("authorization", `Token ${this.config.apiToken}`);
    headers.set("user-agent", this.config.userAgent);
    if (input.idempotencyKey) {
      headers.set("x-request-id", input.idempotencyKey);
    }
    let body = input.body;
    if (input.json) {
      headers.set("content-type", "application/json");
      body = JSON.stringify(input.json);
    }
    if (this.config.dryRun) {
      return {
        dryRun: true,
        method: input.method,
        path: url.pathname,
        query: input.query,
        body: input.json,
        notes: input.body instanceof FormData ? ["multipart body omitted in dry-run"] : undefined
      };
    }

    const attempts = Math.max(1, this.config.maxAttempts);
    let lastError: DefectDojoError | null = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(new Error(`request timed out after ${input.timeoutMs ?? this.config.timeoutMs}ms`)),
        input.timeoutMs ?? this.config.timeoutMs
      );
      try {
        const response = await this.fetchImpl(url, {
          method: input.method,
          headers,
          body,
          signal: controller.signal
        });
        const requestId = response.headers.get("x-request-id") ?? undefined;
        if (!response.ok) {
          const details = truncateBody(await response.text());
          const retryable = RETRYABLE_STATUS_CODES.has(response.status);
          const error = new DefectDojoError({
            kind: "http",
            path: url.pathname,
            status: response.status,
            retryable,
            requestId,
            details,
            message: `DefectDojo ${input.method} ${url.pathname} returned ${response.status}`
          });
          if (!retryable || attempt === attempts) {
            throw error;
          }
          await this.sleepImpl(
            parseRetryAfter(response.headers.get("retry-after"), this.now()) ??
              this.config.backoffMs * 2 ** (attempt - 1)
          );
          lastError = error;
          continue;
        }
        if (input.expectJson === false || response.status === 204) {
          return undefined as T;
        }
        return (await response.json()) as T;
      } catch (error) {
        const normalized = normalizeRequestError(error, url.pathname);
        if (!normalized.retryable || attempt === attempts) {
          throw normalized;
        }
        await this.sleepImpl(this.config.backoffMs * 2 ** (attempt - 1));
        lastError = normalized;
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError ?? new DefectDojoError({
      kind: "network",
      path: url.pathname,
      retryable: false,
      message: `DefectDojo ${input.method} ${url.pathname} failed without a response`
    });
  }
}

function normalizeRequestError(error: unknown, path: string): DefectDojoError {
  if (error instanceof DefectDojoError) {
    return error;
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new DefectDojoError({
      kind: "timeout",
      path,
      retryable: true,
      message: `DefectDojo request to ${path} timed out`,
      cause: error
    });
  }
  return new DefectDojoError({
    kind: "network",
    path,
    retryable: true,
    message: `DefectDojo request to ${path} failed`,
    cause: error
  });
}

function productTypeToDryRun(productType: DefectDojoProductType): DefectDojoDryRunOperation {
  return {
    dryRun: true,
    method: "GET",
    path: `/api/v2/product_types/${productType.id}/`
  };
}

function productToDryRun(product: DefectDojoProduct): DefectDojoDryRunOperation {
  return {
    dryRun: true,
    method: "GET",
    path: `/api/v2/products/${product.id}/`
  };
}

function engagementToDryRun(engagement: DefectDojoEngagement): DefectDojoDryRunOperation {
  return {
    dryRun: true,
    method: "GET",
    path: `/api/v2/engagements/${engagement.id}/`
  };
}
