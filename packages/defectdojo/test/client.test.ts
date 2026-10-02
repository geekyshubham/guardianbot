import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildDefectDojoTags,
  buildImmutableScanIdentity,
  DefectDojoClient,
  DefectDojoError,
  resolveDefectDojoConfig
} from "../src/index.js";

function createJsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {})
    }
  });
}

test("the live conformance fixture is non-secret empty Semgrep JSON", async () => {
  const fixture = JSON.parse(
    await readFile(new URL("../fixtures/semgrep-empty.json", import.meta.url), "utf8")
  ) as Record<string, unknown>;
  assert.deepEqual(fixture.results, []);
  assert.deepEqual(fixture.errors, []);
  assert.equal(
    /token|password|secret|credential/i.test(JSON.stringify(fixture)),
    false
  );
});

test("resolves environment references without exposing secret values", () => {
  const config = resolveDefectDojoConfig(
    {
      DEFECTDOJO_URL: "https://dojo.example.com",
      DEFECTDOJO_API_TOKEN: "top-secret"
    },
    {
      baseUrlRef: "DEFECTDOJO_URL",
      apiTokenRef: "DEFECTDOJO_API_TOKEN",
      userAgent: "guardianbot-test"
    }
  );
  assert.equal(config.baseUrl, "https://dojo.example.com/");
  assert.equal(config.apiToken, "top-secret");
  assert.equal(config.refs.apiTokenRef, "DEFECTDOJO_API_TOKEN");
});

test("missing env reference raises a config error without echoing token values", () => {
  assert.throws(
    () =>
      resolveDefectDojoConfig(
        { DEFECTDOJO_URL: "https://dojo.example.com" },
        { baseUrlRef: "DEFECTDOJO_URL", apiTokenRef: "DEFECTDOJO_API_TOKEN" }
      ),
    (error: unknown) =>
      error instanceof DefectDojoError &&
      error.kind === "config" &&
      error.message.includes("DEFECTDOJO_API_TOKEN") &&
      !error.message.includes("top-secret")
  );
});

test("rejects insecure remote URLs and unsafe configuration bounds", () => {
  assert.throws(
    () =>
      resolveDefectDojoConfig(
        {
          DEFECTDOJO_URL: "http://dojo.example.com",
          DEFECTDOJO_API_TOKEN: "token"
        },
        { baseUrlRef: "DEFECTDOJO_URL", apiTokenRef: "DEFECTDOJO_API_TOKEN" }
      ),
    /HTTPS/
  );
  assert.throws(
    () =>
      resolveDefectDojoConfig(
        {
          DEFECTDOJO_URL: "https://dojo.example.com",
          DEFECTDOJO_API_TOKEN: "token"
        },
        {
          baseUrlRef: "DEFECTDOJO_URL",
          apiTokenRef: "DEFECTDOJO_API_TOKEN",
          maxAttempts: 0
        }
      ),
    /maxAttempts/
  );
});

test("refuses cross-origin pagination before forwarding the API token", async () => {
  const calls: string[] = [];
  const client = new DefectDojoClient(
    resolveDefectDojoConfig(
      {
        DEFECTDOJO_URL: "https://dojo.example.com",
        DEFECTDOJO_API_TOKEN: "token"
      },
      { baseUrlRef: "DEFECTDOJO_URL", apiTokenRef: "DEFECTDOJO_API_TOKEN" }
    ),
    {
      fetch: async (input) => {
        const url = String(input);
        calls.push(url);
        return createJsonResponse({
          count: 1,
          next: "https://attacker.example/steal",
          results: [{ id: 1, name: "guardianbot" }]
        });
      }
    }
  );

  await assert.rejects(() => client.listProducts(), /configured origin/);
  assert.deepEqual(calls, ["https://dojo.example.com/api/v2/products/?limit=100"]);
});

test("retries on Retry-After and upserts product hierarchy before importing", async () => {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const sleeps: number[] = [];
  let productListCalls = 0;
  const client = new DefectDojoClient(
    resolveDefectDojoConfig(
      {
        DEFECTDOJO_URL: "https://dojo.example.com",
        DEFECTDOJO_API_TOKEN: "token"
      },
      {
        baseUrlRef: "DEFECTDOJO_URL",
        apiTokenRef: "DEFECTDOJO_API_TOKEN",
        backoffMs: 10
      }
    ),
    {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      fetch: async (input, init) => {
        const url = input instanceof URL ? input.toString() : String(input);
        calls.push({ url, method: init?.method ?? "GET", body: init?.body });
        if (url.includes("/api/v2/product_types/")) {
          return createJsonResponse({ count: 1, next: null, results: [{ id: 11, name: "GitHub Repositories" }] });
        }
        if (url.includes("/api/v2/products/") && init?.method === "GET") {
          productListCalls += 1;
          if (productListCalls === 1) {
            return new Response(JSON.stringify({ detail: "slow down" }), {
              status: 429,
              headers: { "content-type": "application/json", "retry-after": "2" }
            });
          }
          return createJsonResponse({ count: 0, next: null, results: [] });
        }
        if (url.includes("/api/v2/products/") && init?.method === "POST") {
          return createJsonResponse({ id: 21, name: "guardianbot", prod_type: 11, tags: ["b", "a"] }, { status: 201 });
        }
        if (url.includes("/api/v2/engagements/") && init?.method === "GET") {
          return createJsonResponse({ count: 0, next: null, results: [] });
        }
        if (url.includes("/api/v2/engagements/") && init?.method === "POST") {
          const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
          assert.equal(payload.target_start, "2026-07-27");
          assert.equal(payload.target_end, "2027-07-27");
          assert.equal(payload.branch_tag, "main");
          return createJsonResponse({ id: 31, name: "main:nightly", product: 21 }, { status: 201 });
        }
        if (url.includes("/api/v2/tests/") && init?.method === "GET") {
          return createJsonResponse({
            count: 1,
            next: null,
            results: [
              {
                id: 41,
                engagement: 31,
                scan_type: "Semgrep JSON Report",
                title: "main/nightly",
                updated: "2026-07-27T00:00:00Z"
              }
            ]
          });
        }
        if (url.includes("/api/v2/reimport-scan/")) {
          const form = init?.body as FormData;
          assert.equal(form.get("test"), "41");
          assert.equal(form.get("commit_hash"), "abc123");
          assert.equal(form.get("close_old_findings"), "true");
          assert.deepEqual(form.getAll("tags"), ["guardianbot:repo:geekyshubham/guardianbot", "guardianbot:run:9001"]);
          return createJsonResponse({ test: 41, message: "reimported" }, { status: 201 });
        }
        throw new Error(`Unexpected request ${init?.method} ${url}`);
      }
    }
  );

  const context = await client.ensureImportContext({
    productType: { name: "GitHub Repositories" },
    product: { name: "guardianbot", tags: ["b", "a"] },
    engagement: {
      name: "main:nightly",
      targetStart: "2026-07-27",
      targetEnd: "2027-07-27",
      branchTag: "main"
    },
    test: { scanType: "Semgrep JSON Report", title: "main/nightly" }
  });
  assert.ok(!Array.isArray(context));
  assert.equal(context.product.id, 21);
  assert.deepEqual(sleeps, [2000]);

  const result = await client.importScan({
    scanType: "Semgrep JSON Report",
    testTitle: "main/nightly",
    fileName: "semgrep.json",
    contentType: "application/json",
    report: new TextEncoder().encode("{\"results\":[]}"),
    engagementId: context.engagement.id,
    existingTestId: context.test?.id,
    metadata: {
      commitHash: "abc123",
      tags: ["guardianbot:run:9001", "guardianbot:repo:geekyshubham/guardianbot"]
    }
  });
  assert.equal("dryRun" in result, false);
  if (!("dryRun" in result)) {
    assert.equal(result.mode, "reimport");
    assert.equal(result.testId, 41);
  }
});

test("creates a new test import when no prior matching test exists", async () => {
  const calls: string[] = [];
  const client = new DefectDojoClient(
    resolveDefectDojoConfig(
      {
        DEFECTDOJO_URL: "https://dojo.example.com",
        DEFECTDOJO_API_TOKEN: "token"
      },
      {
        baseUrlRef: "DEFECTDOJO_URL",
        apiTokenRef: "DEFECTDOJO_API_TOKEN"
      }
    ),
    {
      fetch: async (input, init) => {
        const url = input instanceof URL ? input.toString() : String(input);
        calls.push(`${init?.method ?? "GET"} ${url}`);
        if (url.includes("/api/v2/import-scan/")) {
          const form = init?.body as FormData;
          assert.equal(form.get("engagement"), "31");
          assert.equal(form.get("test"), null);
          return createJsonResponse({ test: 55, message: "imported" }, { status: 201 });
        }
        return createJsonResponse({ count: 0, next: null, results: [] });
      }
    }
  );

  const result = await client.importScan({
    scanType: "ZAP Scan",
    testTitle: "staging/zap",
    fileName: "zap.json",
    contentType: "application/json",
    report: new TextEncoder().encode("{}"),
    engagementId: 31,
    metadata: {
      branchTag: "main",
      scanDate: "2026-07-27"
    }
  });

  assert.equal("dryRun" in result, false);
  if (!("dryRun" in result)) {
    assert.equal(result.mode, "import");
    assert.equal(result.testId, 55);
  }
  assert.equal(calls.some((call) => call.includes("/api/v2/import-scan/")), true);
});

test("discovers tests and uses import-scan before reimport-scan without manually creating a test", async () => {
  const calls: Array<{ url: string; method: string; body?: BodyInit | null }> = [];
  let imported = false;
  const client = new DefectDojoClient(
    resolveDefectDojoConfig(
      {
        DEFECTDOJO_URL: "https://dojo.example.com",
        DEFECTDOJO_API_TOKEN: "token"
      },
      {
        baseUrlRef: "DEFECTDOJO_URL",
        apiTokenRef: "DEFECTDOJO_API_TOKEN"
      }
    ),
    {
      fetch: async (input, init) => {
        const url = input instanceof URL ? input.toString() : String(input);
        const method = init?.method ?? "GET";
        calls.push({ url, method, body: init?.body });
        if (url.includes("/api/v2/product_types/")) {
          return createJsonResponse({
            count: 1,
            next: null,
            results: [{ id: 11, name: "GitHub Repositories", description: "" }]
          });
        }
        if (url.includes("/api/v2/products/")) {
          return createJsonResponse({
            count: 1,
            next: null,
            results: [{ id: 21, name: "guardianbot", prod_type: 11, tags: [] }]
          });
        }
        if (url.includes("/api/v2/engagements/")) {
          return createJsonResponse({
            count: 1,
            next: null,
            results: [{
              id: 31,
              name: "main/security",
              product: 21,
              target_start: "2026-07-27",
              target_end: "2027-07-27",
              branch_tag: "main",
              tags: []
            }]
          });
        }
        if (url.includes("/api/v2/tests/")) {
          return createJsonResponse({
            count: imported ? 1 : 0,
            next: null,
            results: imported
              ? [{
                  id: 41,
                  engagement: 31,
                  scan_type: "Semgrep JSON Report",
                  title: "main/security"
                }]
              : []
          });
        }
        if (url.includes("/api/v2/import-scan/")) {
          const form = init?.body as FormData;
          assert.equal(form.get("engagement"), "31");
          assert.equal(form.get("test"), null);
          imported = true;
          return createJsonResponse({ test: 41 }, { status: 201 });
        }
        if (url.includes("/api/v2/reimport-scan/")) {
          const form = init?.body as FormData;
          assert.equal(form.get("test"), "41");
          assert.equal(form.get("engagement"), null);
          return createJsonResponse({ test: 41 }, { status: 201 });
        }
        throw new Error(`Unexpected request ${method} ${url}`);
      }
    }
  );

  const context = await client.ensureImportContext({
    productType: { name: "GitHub Repositories" },
    product: { name: "guardianbot" },
    engagement: {
      name: "main/security",
      targetStart: "2026-08-01",
      targetEnd: "2027-08-01",
      branchTag: "main"
    },
    test: {
      scanType: "Semgrep JSON Report",
      title: "main/security"
    }
  });
  assert.ok(!Array.isArray(context));
  assert.equal(context.test, null);
  assert.equal(
    calls.some(
      ({ url, method }) =>
        method === "PATCH" && url.includes("/api/v2/engagements/")
    ),
    false
  );

  const first = await client.importScan({
    scanType: "Semgrep JSON Report",
    testTitle: "main/security",
    fileName: "semgrep.json",
    contentType: "application/json",
    report: new TextEncoder().encode("{\"results\":[]}"),
    engagementId: context.engagement.id
  });
  assert.ok(!("dryRun" in first));
  if ("dryRun" in first) return;
  assert.equal(first.mode, "import");
  assert.equal(first.testId, 41);

  const existing = await client.ensureTest({
    engagementId: context.engagement.id,
    scanType: "Semgrep JSON Report",
    title: "main/security"
  });
  assert.equal(existing?.id, 41);

  const second = await client.importScan({
    scanType: "Semgrep JSON Report",
    testTitle: "main/security",
    fileName: "semgrep.json",
    contentType: "application/json",
    report: new TextEncoder().encode("{\"results\":[]}"),
    engagementId: context.engagement.id,
    existingTestId: existing?.id
  });
  assert.ok(!("dryRun" in second));
  if ("dryRun" in second) return;
  assert.equal(second.mode, "reimport");
  assert.equal(second.testId, 41);
  assert.equal(
    calls.some(({ url, method }) => method === "POST" && url.includes("/api/v2/tests/")),
    false
  );
});

test("rejects invalid or reversed engagement dates before mutation", async () => {
  const client = new DefectDojoClient(
    resolveDefectDojoConfig(
      {
        DEFECTDOJO_URL: "https://dojo.example.com",
        DEFECTDOJO_API_TOKEN: "token"
      },
      { baseUrlRef: "DEFECTDOJO_URL", apiTokenRef: "DEFECTDOJO_API_TOKEN" }
    ),
    {
      fetch: async () => createJsonResponse({ count: 0, next: null, results: [] })
    }
  );

  await assert.rejects(
    () =>
      client.ensureEngagement({
        productId: 1,
        name: "invalid",
        targetStart: "2026-02-30",
        targetEnd: "2027-02-28"
      }),
    /invalid ISO date/
  );
  await assert.rejects(
    () =>
      client.ensureEngagement({
        productId: 1,
        name: "reversed",
        targetStart: "2027-07-27",
        targetEnd: "2026-07-27"
      }),
    /must not be after/
  );
});

test("supports dry-run planning for mutating requests", async () => {
  const client = new DefectDojoClient(
    resolveDefectDojoConfig(
      {
        DEFECTDOJO_URL: "https://dojo.example.com",
        DEFECTDOJO_API_TOKEN: "token"
      },
      {
        baseUrlRef: "DEFECTDOJO_URL",
        apiTokenRef: "DEFECTDOJO_API_TOKEN",
        dryRun: true
      }
    )
  );

  const result = await client.importScan({
    scanType: "Trivy Scan",
    testTitle: "nightly/trivy",
    fileName: "trivy.json",
    contentType: "application/json",
    report: new TextEncoder().encode("{}"),
    engagementId: 8
  });
  assert.equal("dryRun" in result, true);
  if ("dryRun" in result) {
    assert.equal(result.method, "POST");
    assert.equal(result.path, "/api/v2/import-scan/");
    assert.match(result.notes?.[0] ?? "", /multipart body omitted/);
  }
});

test("normalizes timeout and network failures", async () => {
  const client = new DefectDojoClient(
    resolveDefectDojoConfig(
      {
        DEFECTDOJO_URL: "https://dojo.example.com",
        DEFECTDOJO_API_TOKEN: "token"
      },
      {
        baseUrlRef: "DEFECTDOJO_URL",
        apiTokenRef: "DEFECTDOJO_API_TOKEN",
        maxAttempts: 1
      }
    ),
    {
      fetch: async () => {
        throw new DOMException("Timed out", "AbortError");
      }
    }
  );

  await assert.rejects(
    () => client.listProducts(),
    (error: unknown) => error instanceof DefectDojoError && error.kind === "timeout"
  );
});

test("builds stable immutable scan identities and sorted tags", () => {
  const tags = buildDefectDojoTags({
    repositoryId: 1,
    repositorySlug: "Geekyshubham/GuardianBot",
    visibility: "private",
    commitSha: "abc123",
    workflowRunId: "88",
    workflowAttempt: "2",
    branch: "main",
    profile: "nightly",
    scanType: "Trivy Scan",
    environment: "staging",
    imageDigest: "sha256:deadbeef",
    customTags: ["z", "a", "release candidate, \"verified\""]
  });
  assert.deepEqual(tags, [
    "a",
    "guardianbot:attempt:2",
    "guardianbot:branch:main",
    "guardianbot:commit:abc123",
    "guardianbot:env:staging",
    "guardianbot:image:sha256:deadbeef",
    "guardianbot:profile:nightly",
    "guardianbot:repo-id:1",
    "guardianbot:repo:geekyshubham/guardianbot",
    "guardianbot:run:88",
    "guardianbot:scan:Trivy-Scan",
    "guardianbot:visibility:private",
    "release-candidate-verified",
    "z"
  ]);
  assert.equal(
    buildImmutableScanIdentity({
      repositoryId: 1,
      repositorySlug: "Geekyshubham/GuardianBot",
      visibility: "private",
      commitSha: "abc123",
      workflowRunId: "88",
      workflowAttempt: "2",
      branch: "main",
      profile: "nightly",
      scanType: "Trivy Scan",
      environment: "staging",
      imageDigest: "sha256:deadbeef"
    }),
    "1|geekyshubham/guardianbot|private|main|nightly|Trivy Scan|88|2|abc123|staging|sha256:deadbeef"
  );
});

function releaseClient(
  handler: (url: URL) => Response,
  calls: URL[] = []
): DefectDojoClient {
  return new DefectDojoClient(
    resolveDefectDojoConfig(
      {
        DEFECTDOJO_URL: "https://dojo.example.com",
        DEFECTDOJO_API_TOKEN: "token"
      },
      { baseUrlRef: "DEFECTDOJO_URL", apiTokenRef: "DEFECTDOJO_API_TOKEN", pageSize: 2 }
    ),
    {
      fetch: async (input, init) => {
        assert.equal(init?.method ?? "GET", "GET");
        const url = new URL(input instanceof URL ? input.toString() : String(input));
        calls.push(url);
        return handler(url);
      }
    }
  );
}

test("release finding query is read-only, scoped to named engagements, and paginated", async () => {
  const calls: URL[] = [];
  const client = releaseClient((url) => {
    if (url.pathname === "/api/v2/products/") {
      return createJsonResponse({
        next: null,
        results: [
          { id: 7, name: "Geekyshubham/service-old" },
          { id: 8, name: "Geekyshubham/service" }
        ]
      });
    }
    if (url.pathname === "/api/v2/engagements/") {
      return createJsonResponse({
        next: null,
        results: [
          { id: 30, name: "main/security", product: 8 },
          { id: 31, name: "main/image", product: 8 },
          { id: 32, name: "feature/security", product: 8 },
          { id: 33, name: "main/dast", product: 9 }
        ]
      });
    }
    if (url.pathname === "/api/v2/tests/") {
      const engagement = Number(url.searchParams.get("engagement"));
      return createJsonResponse({
        next: null,
        results: [
          { id: engagement * 10, engagement, tags: ["guardianbot:repo-id:99"] },
          { id: 999, engagement: 77 }
        ]
      });
    }
    if (url.pathname === "/api/v2/findings/") {
      const engagement = Number(url.searchParams.get("test__engagement"));
      if (url.searchParams.get("risk_accepted") === "true") {
        return createJsonResponse({ next: null, results: [] });
      }
      if (!url.searchParams.has("offset")) {
        return createJsonResponse({
          next: `https://dojo.example.com/api/v2/findings/?test__engagement=${engagement}&offset=2`,
          results: [{ id: engagement * 100, test: engagement * 10, severity: "Critical" }]
        });
      }
      return createJsonResponse({
        next: null,
        results: [
          { id: engagement * 100 + 1, test: engagement * 10, severity: "High" },
          { id: engagement * 100 + 2, test: 999, severity: "Critical" }
        ]
      });
    }
    throw new Error(`unexpected ${url}`);
  }, calls);

  const result = await client.listReleaseFindings({
    productName: "Geekyshubham/service",
    engagementNames: ["main/security", "main/image"]
  });
  assert.equal(result.product?.id, 8);
  assert.deepEqual(
    result.engagements.map((engagement) => engagement.id),
    [30, 31]
  );
  assert.deepEqual(
    result.tests.map((entry) => entry.id),
    [300, 310]
  );
  // Findings whose Test is outside the listed engagements are dropped.
  assert.deepEqual(
    result.findings.map((finding) => finding.id),
    [3000, 3001, 3100, 3101]
  );
  const openQuery = calls.find(
    (url) =>
      url.pathname === "/api/v2/findings/" &&
      url.searchParams.get("active") === "true"
  );
  assert.ok(openQuery);
  assert.equal(openQuery.searchParams.get("verified"), "true");
  assert.equal(openQuery.searchParams.get("false_p"), "false");
  assert.equal(openQuery.searchParams.get("duplicate"), "false");
  assert.equal(openQuery.searchParams.get("out_of_scope"), "false");
  assert.equal(openQuery.searchParams.get("is_mitigated"), "false");
  assert.ok(
    calls.some(
      (url) =>
        url.pathname === "/api/v2/findings/" &&
        url.searchParams.get("risk_accepted") === "true"
    )
  );
});

test("release finding query can include unverified findings", async () => {
  const calls: URL[] = [];
  const client = releaseClient((url) => {
    if (url.pathname === "/api/v2/products/") {
      return createJsonResponse({ next: null, results: [{ id: 8, name: "acme/app" }] });
    }
    if (url.pathname === "/api/v2/engagements/") {
      return createJsonResponse({ next: null, results: [{ id: 1, name: "main/image", product: 8 }] });
    }
    return createJsonResponse({ next: null, results: [] });
  }, calls);
  await client.listReleaseFindings({
    productName: "acme/app",
    engagementNames: ["main/image"],
    verifiedOnly: false
  });
  const openQuery = calls.find(
    (url) => url.pathname === "/api/v2/findings/" && url.searchParams.get("active") === "true"
  );
  assert.equal(openQuery?.searchParams.has("verified"), false);
});

test("release finding query reports a missing product without guessing", async () => {
  const client = releaseClient(() => createJsonResponse({ next: null, results: [{ id: 1, name: "acme/other" }] }));
  const result = await client.listReleaseFindings({
    productName: "acme/app",
    engagementNames: ["main/image"]
  });
  assert.equal(result.product, null);
  assert.deepEqual(result.findings, []);
});

test("release finding query fails instead of truncating past its page cap", async () => {
  let page = 0;
  const client = releaseClient((url) => {
    if (url.pathname === "/api/v2/products/") {
      return createJsonResponse({ next: null, results: [{ id: 8, name: "acme/app" }] });
    }
    if (url.pathname === "/api/v2/engagements/") {
      return createJsonResponse({ next: null, results: [{ id: 1, name: "main/image", product: 8 }] });
    }
    if (url.pathname === "/api/v2/tests/") {
      return createJsonResponse({ next: null, results: [{ id: 10, engagement: 1 }] });
    }
    page += 1;
    return createJsonResponse({
      next: `https://dojo.example.com/api/v2/findings/?offset=${page * 2}`,
      results: [{ id: page, test: 10, severity: "Critical" }]
    });
  });
  await assert.rejects(
    () =>
      client.listReleaseFindings({
        productName: "acme/app",
        engagementNames: ["main/image"],
        maxPages: 3
      }),
    (error: unknown) =>
      error instanceof DefectDojoError &&
      error.kind === "validation" &&
      /maximum page count/.test(error.message)
  );
  await assert.rejects(
    () =>
      client.listReleaseFindings({
        productName: "acme/app",
        engagementNames: [],
        maxPages: 3
      }),
    /engagement names/
  );
  await assert.rejects(
    () =>
      client.listReleaseFindings({
        productName: "acme/app",
        engagementNames: ["main/image"],
        maxPages: 0
      }),
    /maxPages/
  );
});

test("release finding query looks engagements up by exact name and rejects malformed records", async () => {
  const calls: URL[] = [];
  const client = releaseClient((url) => {
    if (url.pathname === "/api/v2/products/") {
      return createJsonResponse({ next: null, results: [{ id: 8, name: "acme/app" }] });
    }
    if (url.pathname === "/api/v2/engagements/") {
      return createJsonResponse({
        next: null,
        results: [{ id: 1, name: url.searchParams.get("name"), product: 8 }]
      });
    }
    if (url.pathname === "/api/v2/tests/") {
      return createJsonResponse({ next: null, results: [{ id: 10, engagement: 1 }] });
    }
    return createJsonResponse({ next: null, results: [{ id: 5, test: "10", severity: "Critical" }] });
  }, calls);
  await assert.rejects(
    () => client.listReleaseFindings({ productName: "acme/app", engagementNames: ["main/image"] }),
    (error: unknown) =>
      error instanceof DefectDojoError && /malformed Test or Finding/.test(error.message)
  );
  const engagementQuery = calls.find((url) => url.pathname === "/api/v2/engagements/");
  assert.equal(engagementQuery?.searchParams.get("name"), "main/image");
  assert.equal(engagementQuery?.searchParams.get("product"), "8");
});
