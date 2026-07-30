import assert from "node:assert/strict";
import test from "node:test";

import {
  BASELINE_SCHEMA_VERSION,
  CALLER_WORKFLOW_PATH,
  DETERMINISTIC_SCANNER_JOB,
  EnforcementReadinessError,
  REUSABLE_SECURITY_WORKFLOW_PATH,
  RULESET_NAME,
  parseEnforceBaseline,
  verifyEnforcementReadiness
} from "./verify-enforcement-readiness.mjs";

const REPO = "acme/service";
const WORKFLOW_REPO = "acme/guardianbot";
const SOURCE_HEAD = "c".repeat(40);
const OBS_HEAD = "b".repeat(40);
const GATE = "a".repeat(64);
const FP = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const TOKEN = "ghs_test_token_do_not_leak_sentinel";
const BODY_SENTINEL = "RESPONSE_BODY_SECRET_SENTINEL";
const SOURCE_RUN_ID = 200;
const SOURCE_RUN_ATTEMPT = 1;
const OBS_RUN_ID = 100;
const OBS_RUN_ATTEMPT = 1;
const RULESET_ID = 81;
const REQUIRED_CHECK = DETERMINISTIC_SCANNER_JOB;
const WORKFLOW_VERSION = "d".repeat(40);
const OBS_WORKFLOW_VERSION = "e".repeat(40);
const GENERATED_AT = "2026-06-01T00:00:00.000Z";

const SEVEN_DAYS_MS = 7 * 86_400_000;
const NOW = Date.parse("2026-07-15T12:00:00.000Z");
const SOURCE_STARTED = new Date(NOW - 60_000).toISOString();
const OBS_STARTED = new Date(NOW - SEVEN_DAYS_MS).toISOString();

function versionedBaseline(overrides = {}) {
  const source = {
    gateSha256: GATE,
    mode: "report-only",
    repository: REPO,
    headSha: SOURCE_HEAD,
    runId: SOURCE_RUN_ID,
    runAttempt: SOURCE_RUN_ATTEMPT,
    ...(overrides.source ?? {})
  };
  const observation = {
    repository: REPO,
    headSha: OBS_HEAD,
    runId: OBS_RUN_ID,
    runAttempt: OBS_RUN_ATTEMPT,
    startedAt: OBS_STARTED,
    ...(overrides.observation ?? {})
  };
  const document = {
    schemaVersion: BASELINE_SCHEMA_VERSION,
    fingerprints: overrides.fingerprints ?? [FP],
    generatedAt: overrides.generatedAt ?? GENERATED_AT,
    source,
    observation
  };
  if (overrides.schemaVersion !== undefined) {
    document.schemaVersion = overrides.schemaVersion;
  }
  if (overrides.omitSource) delete document.source;
  if (overrides.omitObservation) delete document.observation;
  return JSON.stringify(document);
}

function referencedSecurity(workflowVersion = WORKFLOW_VERSION, workflowRepo = WORKFLOW_REPO) {
  return {
    path: `${workflowRepo}/${REUSABLE_SECURITY_WORKFLOW_PATH}@${workflowVersion}`,
    sha: workflowVersion
  };
}

function gateRun({
  runId,
  runAttempt,
  headSha,
  startedAt,
  workflowVersion = WORKFLOW_VERSION,
  ...overrides
} = {}) {
  return {
    id: runId,
    run_attempt: runAttempt,
    head_sha: headSha,
    status: "completed",
    conclusion: "success",
    event: "push",
    path: CALLER_WORKFLOW_PATH,
    name: "GuardianBot",
    run_started_at: startedAt,
    created_at: startedAt,
    repository: { full_name: REPO },
    head_repository: { full_name: REPO },
    referenced_workflows: [referencedSecurity(workflowVersion)],
    ...overrides
  };
}

function sourceRun(overrides = {}) {
  return gateRun({
    runId: SOURCE_RUN_ID,
    runAttempt: SOURCE_RUN_ATTEMPT,
    headSha: SOURCE_HEAD,
    startedAt: SOURCE_STARTED,
    ...overrides
  });
}

function observationRun(overrides = {}) {
  return gateRun({
    runId: OBS_RUN_ID,
    runAttempt: OBS_RUN_ATTEMPT,
    headSha: OBS_HEAD,
    startedAt: OBS_STARTED,
    ...overrides
  });
}

function scannerJob(overrides = {}) {
  return {
    id: 1,
    name: DETERMINISTIC_SCANNER_JOB,
    status: "completed",
    conclusion: "success",
    ...overrides
  };
}

function activeRuleset(overrides = {}) {
  return {
    id: RULESET_ID,
    name: RULESET_NAME,
    target: "branch",
    enforcement: "active",
    conditions: {
      ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] }
    },
    rules: [
      {
        type: "required_status_checks",
        parameters: {
          strict_required_status_checks_policy: true,
          required_status_checks: [{ context: REQUIRED_CHECK }]
        }
      }
    ],
    ...overrides
  };
}

function sourceConfig(overrides = {}) {
  return {
    schemaVersion: "1.0.0",
    scannersMode: "report-only",
    workflowVersion: WORKFLOW_VERSION,
    ...overrides
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

function errorResponse(status, body = BODY_SENTINEL) {
  return new Response(body, { status });
}

function resolveFetchUrl(input) {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return input;
  if (input && typeof input === "object" && typeof input.url === "string") {
    return new URL(input.url);
  }
  throw new TypeError("fetch input must be a string, URL, or Request-like object");
}

function makeFetch(routes) {
  return async (input) => {
    const url = resolveFetchUrl(input);
    const key = `${url.pathname}${url.search}`;
    const handler = routes.find((route) => {
      if (typeof route.match === "string") {
        return key === route.match || url.pathname === route.match;
      }
      return route.match.test(key) || route.match.test(url.pathname);
    });
    if (!handler) {
      return errorResponse(404, `missing route ${key} ${BODY_SENTINEL}`);
    }
    if (typeof handler.response === "function") {
      return handler.response(url);
    }
    return handler.response;
  };
}

function runRoutes(runId, runAttempt, run, jobs) {
  return [
    {
      match: `/repos/acme/service/actions/runs/${runId}/attempts/${runAttempt}`,
      response: jsonResponse(run)
    },
    {
      match: new RegExp(
        `/repos/acme/service/actions/runs/${runId}/attempts/${runAttempt}/jobs`
      ),
      response: jsonResponse({ jobs })
    }
  ];
}

function defaultRoutes(overrides = {}) {
  const run = overrides.run ?? sourceRun();
  const jobs = overrides.jobs ?? [scannerJob({ id: 1 })];
  const obsRun = overrides.observationRun ?? observationRun();
  const obsJobs = overrides.observationJobs ?? [scannerJob({ id: 2 })];
  const rulesets = overrides.rulesets ?? [activeRuleset()];

  // Route paths use baseline identity, not response body fields, so wrong
  // id/attempt body values still hit the expected endpoint.
  const sourceId = overrides.sourceRunId ?? SOURCE_RUN_ID;
  const sourceAttempt = overrides.sourceRunAttempt ?? SOURCE_RUN_ATTEMPT;
  const obsId = overrides.observationRunId ?? OBS_RUN_ID;
  const obsAttempt = overrides.observationRunAttempt ?? OBS_RUN_ATTEMPT;
  const sameRun = sourceId === obsId && sourceAttempt === obsAttempt;

  const routes = [
    ...runRoutes(sourceId, sourceAttempt, run, jobs),
    ...(sameRun ? [] : runRoutes(obsId, obsAttempt, obsRun, obsJobs)),
    {
      match: new RegExp(`/repos/acme/service/rulesets\\?`),
      response: jsonResponse(rulesets)
    },
    {
      match: `/repos/acme/service/rulesets/${RULESET_ID}`,
      response: jsonResponse(activeRuleset())
    },
    ...(overrides.extraRoutes ?? [])
  ];
  return routes;
}

async function verify(overrides = {}) {
  const options = {
    configPath: overrides.configPath ?? ".guardianbot/config.yml",
    repository: overrides.repository ?? REPO,
    workflowRepository: overrides.workflowRepository ?? WORKFLOW_REPO,
    defaultBranch: overrides.defaultBranch ?? "main",
    requiredCheckName: overrides.requiredCheckName ?? REQUIRED_CHECK,
    githubApiUrl: overrides.githubApiUrl ?? "https://api.github.com",
    githubToken: overrides.githubToken ?? TOKEN,
    minimumObservationDays: overrides.minimumObservationDays ?? 7,
    fetchImpl: overrides.fetchImpl ?? makeFetch(defaultRoutes(overrides)),
    now: overrides.now ?? (() => NOW),
    resolveSourceConfig:
      overrides.resolveSourceConfig ?? (async () => sourceConfig()),
    sleep: overrides.sleep ?? (async () => {})
  };
  if (Object.hasOwn(overrides, "baselineText")) {
    options.baselineText = overrides.baselineText;
  } else if (Object.hasOwn(overrides, "baselinePath")) {
    options.baselinePath = overrides.baselinePath;
  } else {
    options.baselineText = versionedBaseline();
  }
  return verifyEnforcementReadiness(options);
}

async function assertFails(overrides, pattern) {
  await assert.rejects(
    () => verify(overrides),
    (error) => {
      assert.ok(error instanceof EnforcementReadinessError);
      assert.match(error.message, pattern);
      assert.doesNotMatch(error.message, new RegExp(TOKEN));
      assert.doesNotMatch(error.message, new RegExp(BODY_SENTINEL));
      return true;
    }
  );
}

test("happy path accepts recent source gate plus seven-day observation", async () => {
  const summary = await verify();
  assert.equal(summary.sourceRunId, SOURCE_RUN_ID);
  assert.equal(summary.sourceRunAttempt, SOURCE_RUN_ATTEMPT);
  assert.equal(summary.sourceHeadSha, SOURCE_HEAD);
  assert.equal(summary.observationRunId, OBS_RUN_ID);
  assert.equal(summary.observationRunAttempt, OBS_RUN_ATTEMPT);
  assert.equal(summary.observationHeadSha, OBS_HEAD);
  assert.equal(summary.observationStartedAt, OBS_STARTED);
  assert.equal(summary.rulesetId, RULESET_ID);
  assert.equal(summary.rulesetName, RULESET_NAME);
  assert.equal(summary.requiredCheckName, REQUIRED_CHECK);
  assert.equal(summary.ageDays, 7);
});

test("empty clean versioned baseline is accepted", async () => {
  const summary = await verify({
    baselineText: versionedBaseline({ fingerprints: [] })
  });
  assert.equal(summary.sourceRunId, SOURCE_RUN_ID);
  assert.equal(summary.observationRunId, OBS_RUN_ID);
  assert.equal(summary.ageDays, 7);
});

test("recent source gate is explicitly accepted", async () => {
  const recent = new Date(NOW - 1_000).toISOString();
  const summary = await verify({
    fetchImpl: makeFetch(
      defaultRoutes({
        run: sourceRun({
          run_started_at: recent,
          created_at: recent
        })
      })
    )
  });
  assert.equal(summary.sourceRunId, SOURCE_RUN_ID);
  assert.equal(summary.ageDays, 7);
});

test("legacy array baseline is rejected for enforce authorization", async () => {
  await assertFails(
    { baselineText: JSON.stringify([FP]) },
    /legacy baseline arrays are not authorized/
  );
});

test("versionless object baseline is rejected for enforce authorization", async () => {
  await assertFails(
    {
      baselineText: JSON.stringify({
        fingerprints: [FP],
        generatedAt: GENERATED_AT,
        source: {
          gateSha256: GATE,
          mode: "report-only",
          repository: REPO,
          headSha: SOURCE_HEAD,
          runId: SOURCE_RUN_ID,
          runAttempt: SOURCE_RUN_ATTEMPT
        },
        observation: {
          repository: REPO,
          headSha: OBS_HEAD,
          runId: OBS_RUN_ID,
          runAttempt: OBS_RUN_ATTEMPT,
          startedAt: OBS_STARTED
        }
      })
    },
    /versionless baselines are not authorized|schemaVersion must be/
  );
});

test("parseEnforceBaseline rejects legacy and versionless documents", () => {
  assert.throws(
    () => parseEnforceBaseline("[]", REPO),
    /legacy baseline arrays/
  );
  assert.throws(
    () => parseEnforceBaseline(JSON.stringify({ fingerprints: [FP] }), REPO),
    /versionless|schemaVersion/
  );
});

test("parseEnforceBaseline requires observation block", () => {
  assert.throws(
    () =>
      parseEnforceBaseline(
        versionedBaseline({ omitObservation: true }),
        REPO
      ),
    /observation must be an object/
  );
});

test("wrong source repository is rejected", async () => {
  await assertFails(
    {
      baselineText: versionedBaseline({
        source: { repository: "other/repo" }
      })
    },
    /does not match the current repository/
  );
});

test("wrong source head is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          run: sourceRun({ head_sha: "e".repeat(40) })
        })
      )
    },
    /head SHA does not match/
  );
});

test("wrong source attempt is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          run: sourceRun({ run_attempt: 2 })
        })
      )
    },
    /attempt does not match/
  );
});

test("wrong source event is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          run: sourceRun({ event: "pull_request" })
        })
      )
    },
    /push or workflow_dispatch/
  );
});

test("scheduled source run is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          run: sourceRun({ event: "schedule" })
        })
      )
    },
    /push or workflow_dispatch/
  );
});

test("wrong workflow path is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          run: sourceRun({ path: ".github/workflows/other.yml" })
        })
      )
    },
    /path must be/
  );
});

test("workflow path with @ref is stripped before comparison", async () => {
  const summary = await verify({
    fetchImpl: makeFetch(
      defaultRoutes({
        run: sourceRun({
          path: `${CALLER_WORKFLOW_PATH}@${SOURCE_HEAD}`
        })
      })
    )
  });
  assert.equal(summary.sourceRunId, SOURCE_RUN_ID);
});

test("wrong workflow name is rejected when present", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          run: sourceRun({ name: "NotGuardianBot" })
        })
      )
    },
    /name must be GuardianBot/
  );
});

test("incomplete source run status is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          run: sourceRun({ status: "in_progress" })
        })
      )
    },
    /not completed/
  );
});

test("too-recent observation run is rejected", async () => {
  const recent = new Date(NOW - SEVEN_DAYS_MS + 1_000).toISOString();
  await assertFails(
    {
      baselineText: versionedBaseline({
        observation: { startedAt: recent }
      }),
      fetchImpl: makeFetch(
        defaultRoutes({
          observationRun: observationRun({
            run_started_at: recent,
            created_at: recent
          })
        })
      )
    },
    /too recent/
  );
});

test("exactly seven days old observation run is accepted", async () => {
  const exact = new Date(NOW - SEVEN_DAYS_MS).toISOString();
  const summary = await verify({
    baselineText: versionedBaseline({
      observation: { startedAt: exact }
    }),
    fetchImpl: makeFetch(
      defaultRoutes({
        observationRun: observationRun({
          run_started_at: exact,
          created_at: exact
        })
      })
    )
  });
  assert.equal(summary.ageDays, 7);
  assert.equal(summary.observationStartedAt, exact);
});

test("materially future observation timestamp is rejected", async () => {
  const future = new Date(NOW + 10 * 60 * 1000).toISOString();
  await assertFails(
    {
      baselineText: versionedBaseline({
        observation: { startedAt: future }
      }),
      fetchImpl: makeFetch(
        defaultRoutes({
          observationRun: observationRun({
            run_started_at: future,
            created_at: future
          })
        })
      )
    },
    /future/
  );
});

test("same source and observation run is accepted when old enough", async () => {
  const old = new Date(NOW - SEVEN_DAYS_MS).toISOString();
  const shared = gateRun({
    runId: SOURCE_RUN_ID,
    runAttempt: SOURCE_RUN_ATTEMPT,
    headSha: SOURCE_HEAD,
    startedAt: old
  });
  const summary = await verify({
    baselineText: versionedBaseline({
      observation: {
        repository: REPO,
        headSha: SOURCE_HEAD,
        runId: SOURCE_RUN_ID,
        runAttempt: SOURCE_RUN_ATTEMPT,
        startedAt: old
      }
    }),
    fetchImpl: makeFetch(
      defaultRoutes({
        run: shared,
        observationRun: shared,
        jobs: [scannerJob()],
        observationRunId: SOURCE_RUN_ID,
        observationRunAttempt: SOURCE_RUN_ATTEMPT
      })
    )
  });
  assert.equal(summary.sourceRunId, SOURCE_RUN_ID);
  assert.equal(summary.observationRunId, SOURCE_RUN_ID);
  assert.equal(summary.ageDays, 7);
});

test("same source and observation run is rejected when too recent", async () => {
  const recent = new Date(NOW - 60_000).toISOString();
  const shared = gateRun({
    runId: SOURCE_RUN_ID,
    runAttempt: SOURCE_RUN_ATTEMPT,
    headSha: SOURCE_HEAD,
    startedAt: recent
  });
  await assertFails(
    {
      baselineText: versionedBaseline({
        observation: {
          repository: REPO,
          headSha: SOURCE_HEAD,
          runId: SOURCE_RUN_ID,
          runAttempt: SOURCE_RUN_ATTEMPT,
          startedAt: recent
        }
      }),
      fetchImpl: makeFetch(
        defaultRoutes({
          run: shared,
          observationRun: shared,
          jobs: [scannerJob()],
          observationRunId: SOURCE_RUN_ID,
          observationRunAttempt: SOURCE_RUN_ATTEMPT
        })
      )
    },
    /too recent/
  );
});

test("wrong observation repository is rejected", async () => {
  await assertFails(
    {
      baselineText: versionedBaseline({
        observation: { repository: "other/repo" }
      })
    },
    /does not match the current repository/
  );
});

test("wrong observation head is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          observationRun: observationRun({ head_sha: "e".repeat(40) })
        })
      )
    },
    /observation run head SHA does not match/
  );
});

test("wrong observation attempt is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          observationRun: observationRun({ run_attempt: 2 })
        })
      )
    },
    /observation run attempt does not match/
  );
});

test("wrong observation event is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          observationRun: observationRun({ event: "pull_request" })
        })
      )
    },
    /observation run event must be push or workflow_dispatch/
  );
});

test("wrong observation workflow path is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          observationRun: observationRun({
            path: ".github/workflows/other.yml"
          })
        })
      )
    },
    /observation run path must be/
  );
});

test("wrong observation workflow name is rejected when present", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          observationRun: observationRun({ name: "NotGuardianBot" })
        })
      )
    },
    /observation run name must be GuardianBot/
  );
});

test("missing observation deterministic scanner job is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          observationJobs: [
            {
              id: 9,
              name: "guardianbot/security-gate",
              status: "completed",
              conclusion: "success"
            }
          ]
        })
      )
    },
    /observation run is missing the exact job/
  );
});

test("observation config enforce mode is rejected", async () => {
  await assertFails(
    {
      resolveSourceConfig: async ({ headSha }) => {
        if (headSha === OBS_HEAD) {
          return sourceConfig({ scannersMode: "enforce" });
        }
        return sourceConfig();
      }
    },
    /observation config scanners\.mode must be report-only|report-only/
  );
});

test("observation startedAt mismatch with API timestamp is rejected", async () => {
  const mismatched = new Date(NOW - SEVEN_DAYS_MS - 3_600_000).toISOString();
  await assertFails(
    {
      baselineText: versionedBaseline({
        observation: { startedAt: mismatched }
      })
      // API observation run still uses OBS_STARTED
    },
    /does not match baseline observation\.startedAt/
  );
});

test("missing deterministic scanner job is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          jobs: [
            {
              id: 9,
              name: "guardianbot/security-gate",
              status: "completed",
              conclusion: "success"
            }
          ]
        })
      )
    },
    /missing the exact job/
  );
});

test("failed deterministic scanner job is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          jobs: [scannerJob({ conclusion: "failure" })]
        })
      )
    },
    /not successful/
  );
});

test("duplicate deterministic scanner jobs are rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          jobs: [scannerJob({ id: 1 }), scannerJob({ id: 2 })]
        })
      )
    },
    /duplicate/
  );
});

test("skipped deterministic scanner job is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          jobs: [scannerJob({ conclusion: "skipped" })]
        })
      )
    },
    /skipped/
  );
});

test("source config enforce mode is rejected", async () => {
  await assertFails(
    {
      resolveSourceConfig: async () => sourceConfig({ scannersMode: "enforce" })
    },
    /report-only/
  );
});

test("source config advisory mode is rejected", async () => {
  await assertFails(
    {
      resolveSourceConfig: async () =>
        sourceConfig({ scannersMode: "advisory" })
    },
    /report-only/
  );
});

test("mutable workflowVersion is rejected", async () => {
  await assertFails(
    {
      resolveSourceConfig: async () =>
        sourceConfig({ workflowVersion: "main" })
    },
    /workflowVersion/
  );
});

test("wrong source config schemaVersion is rejected", async () => {
  await assertFails(
    {
      resolveSourceConfig: async () =>
        sourceConfig({ schemaVersion: "2.0.0" })
    },
    /schemaVersion must be 1\.0\.0/
  );
});

test("missing ruleset is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(defaultRoutes({ rulesets: [] }))
    },
    /ruleset .* is missing/
  );
});

test("inactive ruleset is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          rulesets: [activeRuleset({ enforcement: "disabled" })]
        })
      )
    },
    /not active/
  );
});

test("non-strict ruleset is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          rulesets: [
            activeRuleset({
              rules: [
                {
                  type: "required_status_checks",
                  parameters: {
                    strict_required_status_checks_policy: false,
                    required_status_checks: [{ context: REQUIRED_CHECK }]
                  }
                }
              ]
            })
          ]
        })
      )
    },
    /does not require strict status check/
  );
});

test("wrong ruleset context is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          rulesets: [
            activeRuleset({
              rules: [
                {
                  type: "required_status_checks",
                  parameters: {
                    strict_required_status_checks_policy: true,
                    required_status_checks: [
                      { context: "guardianbot/security-gate" }
                    ]
                  }
                }
              ]
            })
          ]
        })
      )
    },
    /does not require strict status check/
  );
});

test("ruleset that does not apply to default branch is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          rulesets: [
            activeRuleset({
              conditions: {
                ref_name: {
                  include: ["refs/heads/develop"],
                  exclude: []
                }
              }
            })
          ]
        })
      )
    },
    /does not apply to the default branch/
  );
});

test("API 403 fails closed without leaking token or body", async () => {
  await assertFails(
    {
      fetchImpl: async () => errorResponse(403, `${BODY_SENTINEL} ${TOKEN}`)
    },
    /403|permissions/
  );
});

test("exhausted 429 fails closed without leaking token or body", async () => {
  let calls = 0;
  await assertFails(
    {
      fetchImpl: async () => {
        calls += 1;
        return errorResponse(429, `${BODY_SENTINEL} ${TOKEN}`);
      },
      sleep: async () => {}
    },
    /429/
  );
  assert.equal(calls, 4);
});

test("errors never include the token or response body sentinel on invalid JSON", async () => {
  await assertFails(
    {
      fetchImpl: async () =>
        new Response(`not-json ${BODY_SENTINEL} ${TOKEN}`, {
          status: 200,
          headers: { "content-type": "application/json" }
        })
    },
    /invalid JSON/
  );
});

test("workflow_dispatch source run is accepted", async () => {
  const summary = await verify({
    fetchImpl: makeFetch(
      defaultRoutes({
        run: sourceRun({ event: "workflow_dispatch" })
      })
    )
  });
  assert.equal(summary.sourceRunId, SOURCE_RUN_ID);
});

test("aggregate security-gate job alone does not satisfy deterministic job", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          jobs: [
            {
              id: 3,
              name: "guardianbot/security-gate / other",
              status: "completed",
              conclusion: "success"
            },
            {
              id: 4,
              name: "guardianbot/security-gate",
              status: "completed",
              conclusion: "success"
            }
          ]
        })
      )
    },
    /missing the exact job/
  );
});

test("minimum observation days below seven is rejected", async () => {
  await assertFails({ minimumObservationDays: 6 }, /integer >= 7/);
});

test("unsafe baseline path is rejected", async () => {
  await assertFails(
    { baselinePath: "../secret.json" },
    /allowlisted path|relative/
  );
});

test("makeFetch accepts string, URL, and Request-like inputs", async () => {
  const routes = defaultRoutes();
  const fetchImpl = makeFetch(routes);
  const path = `/repos/acme/service/actions/runs/${SOURCE_RUN_ID}/attempts/${SOURCE_RUN_ATTEMPT}`;
  const asString = await fetchImpl(`https://api.github.com${path}`);
  assert.equal(asString.status, 200);
  const asUrl = await fetchImpl(new URL(`https://api.github.com${path}`));
  assert.equal(asUrl.status, 200);
  const asRequestLike = await fetchImpl({
    url: `https://api.github.com${path}`
  });
  assert.equal(asRequestLike.status, 200);
});

test("missing referenced_workflows is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          run: sourceRun({ referenced_workflows: undefined })
        })
      )
    },
    /referenced_workflows must be a non-empty array/
  );
});

test("empty referenced_workflows is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          run: sourceRun({ referenced_workflows: [] })
        })
      )
    },
    /referenced_workflows must be a non-empty array/
  );
});

test("wrong referenced workflow repository is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          run: sourceRun({
            referenced_workflows: [
              referencedSecurity(WORKFLOW_VERSION, "evil/other")
            ]
          })
        })
      )
    },
    /does not reference the expected reusable-security workflow/
  );
});

test("wrong referenced workflow path is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          run: sourceRun({
            referenced_workflows: [
              {
                path: `${WORKFLOW_REPO}/.github/workflows/reusable-other.yml@${WORKFLOW_VERSION}`,
                sha: WORKFLOW_VERSION
              }
            ]
          })
        })
      )
    },
    /does not reference the expected reusable-security workflow/
  );
});

test("mutable referenced workflow ref is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          run: sourceRun({
            referenced_workflows: [
              {
                path: `${WORKFLOW_REPO}/${REUSABLE_SECURITY_WORKFLOW_PATH}@main`,
                sha: WORKFLOW_VERSION
              }
            ]
          })
        })
      )
    },
    /does not reference the expected reusable-security workflow|immutable/
  );
});

test("wrong referenced_workflows.sha is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          run: sourceRun({
            referenced_workflows: [
              {
                path: `${WORKFLOW_REPO}/${REUSABLE_SECURITY_WORKFLOW_PATH}@${WORKFLOW_VERSION}`,
                sha: "f".repeat(40)
              }
            ]
          })
        })
      )
    },
    /referenced_workflows\.sha does not match workflowVersion/
  );
});

test("duplicate matching referenced workflows are rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          run: sourceRun({
            referenced_workflows: [
              referencedSecurity(),
              referencedSecurity()
            ]
          })
        })
      )
    },
    /duplicate reusable-security workflow references/
  );
});

test("case-insensitive workflow repository matching is accepted", async () => {
  const summary = await verify({
    workflowRepository: "Acme/GuardianBot",
    fetchImpl: makeFetch(
      defaultRoutes({
        run: sourceRun({
          referenced_workflows: [
            {
              path: `AcMe/GuArDiAnBoT/${REUSABLE_SECURITY_WORKFLOW_PATH}@${WORKFLOW_VERSION}`,
              sha: WORKFLOW_VERSION
            }
          ]
        }),
        observationRun: observationRun({
          referenced_workflows: [
            {
              path: `acme/guardianbot/${REUSABLE_SECURITY_WORKFLOW_PATH}@${WORKFLOW_VERSION}`,
              sha: WORKFLOW_VERSION
            }
          ]
        })
      })
    )
  });
  assert.equal(summary.sourceRunId, SOURCE_RUN_ID);
});

test("source and observation may pin different immutable workflowVersions", async () => {
  const summary = await verify({
    resolveSourceConfig: async ({ headSha }) => {
      if (headSha === OBS_HEAD) {
        return sourceConfig({ workflowVersion: OBS_WORKFLOW_VERSION });
      }
      return sourceConfig({ workflowVersion: WORKFLOW_VERSION });
    },
    fetchImpl: makeFetch(
      defaultRoutes({
        run: sourceRun({
          referenced_workflows: [referencedSecurity(WORKFLOW_VERSION)]
        }),
        observationRun: observationRun({
          workflowVersion: OBS_WORKFLOW_VERSION,
          referenced_workflows: [referencedSecurity(OBS_WORKFLOW_VERSION)]
        })
      })
    )
  });
  assert.equal(summary.sourceRunId, SOURCE_RUN_ID);
  assert.equal(summary.observationRunId, OBS_RUN_ID);
});

test("missing workflowRepository is rejected", async () => {
  await assertFails({ workflowRepository: "" }, /workflowRepository must be OWNER\/REPO/);
});

test("observation missing referenced_workflows is rejected", async () => {
  await assertFails(
    {
      fetchImpl: makeFetch(
        defaultRoutes({
          observationRun: observationRun({ referenced_workflows: [] })
        })
      )
    },
    /observation run referenced_workflows must be a non-empty array/
  );
});
