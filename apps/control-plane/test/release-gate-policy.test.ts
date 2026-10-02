import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_RELEASE_GATE_POLICY,
  evaluateReleaseGate,
  parseReleaseGatePolicy,
  type ReleaseDefectDojoState,
  type ReleaseDojoFinding,
  type ReleaseDojoTest,
  type ReleaseGateEvaluationInput,
  type ReleaseGatePolicy
} from "../src/release-gate-policy.js";

const NOW = new Date("2026-08-01T12:00:00.000Z");
const COMMIT = "a".repeat(40);
const OLD_COMMIT = "c".repeat(40);
const DIGEST = `sha256:${"b".repeat(64)}`;
const OLD_DIGEST = `sha256:${"e".repeat(64)}`;
const IDENTITY =
  "https://github.com/geekyshubham/guardianbot/.github/workflows/reusable-image.yml@" +
  "f".repeat(40);

function policy(overrides: Partial<ReleaseGatePolicy> = {}): ReleaseGatePolicy {
  return { ...structuredClone(DEFAULT_RELEASE_GATE_POLICY), ...overrides } as ReleaseGatePolicy;
}

function tags(profile: string, extra: string[] = [], repoId = 99, commit = COMMIT): string[] {
  return [
    `guardianbot:repo-id:${repoId}`,
    "guardianbot:repo:geekyshubham-service",
    `guardianbot:commit:${commit}`,
    `guardianbot:profile:${profile}`,
    ...extra
  ];
}

const TESTS: ReleaseDojoTest[] = [
  { id: 1, engagement: 10, scan_type: "Semgrep JSON Report", tags: tags("security") },
  { id: 2, engagement: 11, scan_type: "Trivy Scan", tags: tags("image") },
  {
    id: 3,
    engagement: 12,
    scan_type: "ZAP Scan",
    tags: tags("dast", [`guardianbot:image:${DIGEST}`, "guardianbot:env:staging"])
  }
];

function dojo(
  findings: ReleaseDojoFinding[] = [],
  acceptedFindings: ReleaseDojoFinding[] = [],
  tests: ReleaseDojoTest[] = TESTS
): ReleaseDefectDojoState {
  return { status: "available", productId: 7, tests, findings, acceptedFindings };
}

function finding(overrides: Partial<ReleaseDojoFinding> = {}): ReleaseDojoFinding {
  return {
    id: 100,
    test: 3,
    title: "Reflected XSS",
    severity: "Critical",
    active: true,
    verified: true,
    false_p: false,
    duplicate: false,
    out_of_scope: false,
    is_mitigated: false,
    risk_accepted: false,
    ...overrides
  };
}

function input(overrides: Partial<ReleaseGateEvaluationInput> = {}): ReleaseGateEvaluationInput {
  return {
    candidate: {
      repository: "geekyshubham/service",
      repositoryId: 99,
      commit: COMMIT,
      digest: DIGEST,
      environment: "staging"
    },
    evidence: {
      signature: { digest: DIGEST, certificateIdentity: IDENTITY, ref: "evidence://1/signature" },
      imageScan: { criticalFindings: 0, status: "success", ref: "evidence://1/image-trivy-summary" },
      sbom: { status: "success", ref: "evidence://1/sbom" }
    },
    expectedCertificateIdentity: IDENTITY,
    defectDojo: dojo(),
    policy: policy(),
    now: NOW,
    ...overrides
  };
}

test("passes a signed, Critical-clean candidate with no in-scope blockers", () => {
  const result = evaluateReleaseGate(input());
  assert.equal(result.decision, "pass");
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(
    result.evidence.map((entry) => entry.kind),
    ["signature", "image-scan", "sbom", "defectdojo"]
  );
  assert.equal(result.evaluatedAt, NOW.toISOString());
});

test("fails an unsigned digest and a signature for another digest", () => {
  const { signature: _ignored, ...unsigned } = input().evidence;
  assert.deepEqual(
    evaluateReleaseGate(input({ evidence: unsigned })).blockers.map((entry) => entry.code),
    ["unsigned-digest"]
  );
  const other = evaluateReleaseGate(
    input({
      evidence: {
        ...input().evidence,
        signature: { digest: OLD_DIGEST, certificateIdentity: IDENTITY, ref: "evidence://0/signature" }
      }
    })
  );
  assert.equal(other.decision, "fail");
  assert.deepEqual(other.blockers.map((entry) => entry.code), ["unsigned-digest"]);
});

test("fails the wrong signer and a missing expected identity", () => {
  const wrong = evaluateReleaseGate(
    input({
      evidence: {
        ...input().evidence,
        signature: {
          digest: DIGEST,
          certificateIdentity: IDENTITY.replace("guardianbot/", "attacker/"),
          ref: "evidence://1/signature"
        }
      }
    })
  );
  assert.deepEqual(wrong.blockers.map((entry) => entry.code), ["wrong-signer"]);
  const unknown = evaluateReleaseGate(input({ expectedCertificateIdentity: undefined }));
  assert.deepEqual(unknown.blockers.map((entry) => entry.code), ["wrong-signer"]);
});

test("blocks active Critical DAST, image, and SAST findings tied to the candidate", () => {
  const result = evaluateReleaseGate(
    input({
      defectDojo: dojo([
        finding({ id: 101, test: 1 }),
        finding({ id: 102, test: 2 }),
        finding({ id: 103, test: 3 })
      ])
    })
  );
  assert.equal(result.decision, "fail");
  assert.deepEqual(
    result.blockers.map((entry) => [entry.code, entry.findingId, entry.source, entry.severity]),
    [
      ["release-blocking-finding", 101, "sast", "critical"],
      ["release-blocking-finding", 102, "image", "critical"],
      ["release-blocking-finding", 103, "dast", "critical"]
    ]
  );
  assert.equal(result.blockers[0]?.ref, "defectdojo://findings/101");
});

test("ignores findings for another product, environment, old digest, or old commit", () => {
  const tests: ReleaseDojoTest[] = [
    ...TESTS,
    { id: 4, engagement: 12, tags: tags("dast", [`guardianbot:image:${DIGEST}`, "guardianbot:env:production"]) },
    { id: 5, engagement: 12, tags: tags("dast", [`guardianbot:image:${OLD_DIGEST}`, "guardianbot:env:staging"]) },
    // An older Test of an already in-scope scan type is history, not a blocker.
    {
      id: 6,
      engagement: 10,
      scan_type: "Semgrep JSON Report",
      tags: tags("security", [], 99, OLD_COMMIT)
    },
    { id: 7, engagement: 10, tags: tags("security", [], 123) }
  ];
  const result = evaluateReleaseGate(
    input({
      defectDojo: dojo(
        [
          finding({ id: 104, test: 4 }),
          finding({ id: 105, test: 5 }),
          finding({ id: 106, test: 6 }),
          finding({ id: 107, test: 7 }),
          finding({ id: 108, test: 999 })
        ],
        [],
        tests
      )
    })
  );
  assert.equal(result.decision, "pass");
  assert.equal(result.ignoredFindings.outOfScope, 5);
});

test("High blocks only when policy says so; lower severities never block by default", () => {
  const findings = [
    finding({ id: 110, severity: "High" }),
    finding({ id: 111, severity: "Medium" })
  ];
  const defaults = evaluateReleaseGate(input({ defectDojo: dojo(findings) }));
  assert.equal(defaults.decision, "pass");
  assert.equal(defaults.ignoredFindings.belowThreshold, 2);
  const strict = evaluateReleaseGate(
    input({ defectDojo: dojo(findings), policy: parseReleaseGatePolicy('{"blockHigh":true}') })
  );
  assert.deepEqual(strict.blockers.map((entry) => entry.findingId), [110]);
});

test("unknown severity fails closed", () => {
  const result = evaluateReleaseGate(input({ defectDojo: dojo([finding({ severity: "S0" })]) }));
  assert.equal(result.blockers[0]?.severity, "unclassified");
});

test("named, unexpired risk acceptance is the only waiver", () => {
  const named = finding({
    id: 120,
    risk_accepted: true,
    accepted_risks: [
      {
        id: 9,
        name: "CVE-2026-1 vendor fix pending",
        expiration_date: "2026-09-01",
        decision: "A",
        accepted_findings: [120]
      }
    ]
  });
  const result = evaluateReleaseGate(input({ defectDojo: dojo([], [named]) }));
  assert.equal(result.decision, "pass");
  assert.deepEqual(result.exceptions, [
    {
      findingId: 120,
      severity: "critical",
      source: "dast",
      riskAcceptanceId: 9,
      riskAcceptanceName: "CVE-2026-1 vendor fix pending",
      expiresAt: "2026-09-01T00:00:00.000Z",
      ref: "defectdojo://findings/120"
    }
  ]);

  const invalid = [
    { id: 10, name: "", expiration_date: "2026-09-01", decision: "A", accepted_findings: [121] },
    { id: 11, name: "expired", expiration_date: "2026-07-01", decision: "A", accepted_findings: [121] },
    { id: 12, name: "no expiry", expiration_date: null, decision: "A", accepted_findings: [121] },
    { id: 13, name: "mitigate decision", expiration_date: "2026-09-01", decision: "M", accepted_findings: [121] },
    { id: 14, name: "other finding", expiration_date: "2026-09-01", decision: "A", accepted_findings: [999] },
    { id: 15, name: "no decision", expiration_date: "2026-09-01", accepted_findings: [121] },
    { id: 16, name: "no finding list", expiration_date: "2026-09-01", decision: "A" }
  ];
  for (const acceptance of invalid) {
    const outcome = evaluateReleaseGate(
      input({
        defectDojo: dojo([], [finding({ id: 121, risk_accepted: true, accepted_risks: [acceptance] })])
      })
    );
    assert.equal(outcome.decision, "fail", acceptance.name);
    assert.equal(outcome.blockers[0]?.code, "risk-acceptance-invalid");
  }
  const bare = evaluateReleaseGate(
    input({ defectDojo: dojo([], [finding({ id: 122, risk_accepted: true })]) })
  );
  assert.equal(bare.blockers[0]?.code, "risk-acceptance-invalid");
});

test("DefectDojo unavailability and missing scope fail closed", () => {
  const unavailable = evaluateReleaseGate(
    input({ defectDojo: { status: "unavailable", reason: "not configured" } })
  );
  assert.equal(unavailable.decision, "fail");
  assert.deepEqual(unavailable.blockers.map((entry) => entry.code), ["gate-unavailable"]);
  const unscoped = evaluateReleaseGate(input({ defectDojo: dojo([], [], []) }));
  assert.deepEqual(
    unscoped.blockers.map((entry) => [entry.code, entry.source]),
    [
      ["defectdojo-scope-missing", "sast"],
      ["defectdojo-scope-missing", "image"]
    ]
  );
  // A DAST import alone does not cover the commit-scoped SAST and image scans.
  const dastOnly = evaluateReleaseGate(input({ defectDojo: dojo([], [], [TESTS[2]!]) }));
  assert.equal(dastOnly.decision, "fail");
  assert.deepEqual(
    dastOnly.blockers.map((entry) => entry.source),
    ["sast", "image"]
  );
});

test("a scan type last reimported for another commit fails closed instead of hiding findings", () => {
  // DefectDojo replaces Test tags on reimport, so the Semgrep Test now
  // describes OLD_COMMIT and its findings for the candidate are unknown.
  const tests: ReleaseDojoTest[] = [
    { id: 1, engagement: 10, scan_type: "Semgrep JSON Report", tags: tags("security", [], 99, OLD_COMMIT) },
    { id: 8, engagement: 10, scan_type: "Trivy Scan", tags: tags("security") },
    TESTS[1]!
  ];
  const result = evaluateReleaseGate(
    input({ defectDojo: dojo([finding({ id: 140, test: 1 })], [], tests) })
  );
  assert.equal(result.decision, "fail");
  assert.deepEqual(result.blockers.map((entry) => [entry.code, entry.source]), [
    ["defectdojo-scope-missing", "sast"]
  ]);
});

test("finding tags cannot move a finding out of its Test's scope", () => {
  const result = evaluateReleaseGate(
    input({
      defectDojo: dojo([
        finding({
          id: 141,
          test: 2,
          tags: [`guardianbot:image:${OLD_DIGEST}`, "guardianbot:env:production", "guardianbot:repo-id:1"]
        })
      ])
    })
  );
  assert.deepEqual(result.blockers.map((entry) => entry.findingId), [141]);
});

test("an acceptance history on a finding that is not risk_accepted is not a waiver", () => {
  const result = evaluateReleaseGate(
    input({
      defectDojo: dojo([
        finding({
          id: 142,
          test: 2,
          risk_accepted: false,
          accepted_risks: [
            { id: 30, name: "old", expiration_date: "2026-09-01", decision: "A", accepted_findings: [142] }
          ]
        })
      ])
    })
  );
  assert.deepEqual(result.blockers.map((entry) => [entry.code, entry.findingId]), [
    ["release-blocking-finding", 142]
  ]);
  assert.deepEqual(result.exceptions, []);
});

test("malformed DefectDojo records fail closed as gate-unavailable", () => {
  const result = evaluateReleaseGate(
    input({
      defectDojo: dojo([{ ...finding({ id: 143 }), test: "2" as unknown as number }])
    })
  );
  assert.deepEqual(result.blockers.map((entry) => entry.code), ["gate-unavailable"]);
});

test("missing or failing evidence blocks", () => {
  const result = evaluateReleaseGate(
    input({
      evidence: {
        signature: input().evidence.signature,
        imageScan: { criticalFindings: 2, status: "success", ref: "evidence://1/image-trivy-summary" }
      }
    })
  );
  assert.deepEqual(result.blockers.map((entry) => entry.code), ["image-scan-critical", "sbom-missing"]);
  const noScan = evaluateReleaseGate(
    input({ evidence: { signature: input().evidence.signature, sbom: input().evidence.sbom } })
  );
  assert.deepEqual(noScan.blockers.map((entry) => entry.code), ["image-scan-missing"]);
});

const REQUIRED_RESCAN = policy({
  requiredEvidence: ["signature", "image-scan", "sbom", "deployed-rescan"]
});

function rescanResult(overrides: Record<string, unknown> = {}) {
  return {
    digest: OLD_DIGEST,
    environment: "staging",
    observedAt: new Date(NOW.getTime() - 3_600_000).toISOString(),
    criticalFindings: 0,
    frozen: false,
    artifactAccepted: true,
    ref: "evidence://2/1/21/image-rescan:staging",
    ...overrides
  };
}

function withRescan(deployedRescan: unknown, extra: Record<string, unknown> = {}) {
  return input({
    policy: REQUIRED_RESCAN,
    evidence: { ...input().evidence, deployedRescan, ...extra } as ReleaseGateEvaluationInput["evidence"]
  });
}

test("required rescan coverage reads the digest deployed in the candidate environment", () => {
  const codes = (value: ReleaseGateEvaluationInput) =>
    evaluateReleaseGate(value).blockers.map((entry) => entry.code);
  // Unknown coverage fails closed.
  assert.deepEqual(codes(input({ policy: REQUIRED_RESCAN })), ["deployed-rescan-missing"]);
  assert.deepEqual(codes(withRescan({ environment: "production" })), ["deployed-rescan-missing"]);
  // First promotion: nothing is deployed yet, so nothing can be rescanned.
  assert.deepEqual(codes(withRescan({ environment: "staging" })), []);
  // A fresh, reconciled rescan of the deployed digest passes a different candidate,
  // even when that rescan froze the deployed digest: replacing it is the fix path.
  const covered = evaluateReleaseGate(
    withRescan({ environment: "staging", deployedDigest: OLD_DIGEST, rescan: rescanResult() })
  );
  assert.equal(covered.decision, "pass");
  assert.ok(covered.evidence.some((entry) => entry.kind === "deployed-rescan"));
  assert.deepEqual(
    codes(
      withRescan({
        environment: "staging",
        deployedDigest: OLD_DIGEST,
        rescan: rescanResult({ frozen: true, criticalFindings: 3 })
      })
    ),
    []
  );
  // No rescan, a rescan of another digest, or one older than 48 hours.
  for (const rescan of [
    undefined,
    rescanResult({ digest: DIGEST }),
    rescanResult({ observedAt: new Date(NOW.getTime() - 49 * 3_600_000).toISOString() }),
    rescanResult({ observedAt: "not a date" })
  ]) {
    assert.deepEqual(
      codes(withRescan({ environment: "staging", deployedDigest: OLD_DIGEST, rescan })),
      ["deployed-rescan-missing"]
    );
  }
  // Verified but not reconciled, or a malformed count.
  for (const rescan of [
    rescanResult({ artifactAccepted: false }),
    rescanResult({ criticalFindings: -1 })
  ]) {
    assert.deepEqual(
      codes(withRescan({ environment: "staging", deployedDigest: OLD_DIGEST, rescan })),
      ["deployed-rescan-failed"]
    );
  }
  // Coverage is not consulted unless the policy requires it.
  assert.equal(evaluateReleaseGate(input()).decision, "pass");
});

test("a frozen candidate digest is blocked whatever the policy requires", () => {
  const frozen = rescanResult({ digest: DIGEST, environment: "production", frozen: true });
  const result = evaluateReleaseGate(
    input({ evidence: { ...input().evidence, candidateRescan: frozen } })
  );
  assert.deepEqual(result.blockers.map((entry) => [entry.code, entry.ref]), [
    ["promotion-frozen", frozen.ref]
  ]);
  assert.match(result.blockers[0]?.message ?? "", /production/);
  // A clean rescan, or a record for another digest, does not block.
  assert.equal(
    evaluateReleaseGate(
      input({ evidence: { ...input().evidence, candidateRescan: { ...frozen, frozen: false } } })
    ).decision,
    "pass"
  );
  assert.equal(
    evaluateReleaseGate(
      input({ evidence: { ...input().evidence, candidateRescan: { ...frozen, digest: OLD_DIGEST } } })
    ).decision,
    "pass"
  );
});

const CLEAN_COUNTS = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };

function staleSemgrep(commitScan: unknown, overrides: Partial<ReleaseGateEvaluationInput> = {}) {
  const tests: ReleaseDojoTest[] = [
    { id: 1, engagement: 10, scan_type: "Semgrep JSON Report", tags: tags("security", [], 99, OLD_COMMIT) },
    { id: 8, engagement: 10, scan_type: "Trivy Scan", tags: tags("security") },
    TESTS[1]!
  ];
  return evaluateReleaseGate(
    input({
      evidence: { ...input().evidence, commitScan } as ReleaseGateEvaluationInput["evidence"],
      defectDojo: dojo([finding({ id: 140, test: 1 })], [], tests),
      ...overrides
    })
  );
}

test("a clean summary of the candidate commit stands in for a scan reimported for a newer commit", () => {
  const semgrep = { status: "success", severities: CLEAN_COUNTS, ref: "evidence://5/1/50/semgrep-summary" };
  const passed = staleSemgrep({ commit: COMMIT, semgrep });
  assert.equal(passed.decision, "pass");
  assert.deepEqual(
    passed.evidence.filter((entry) => entry.kind === "commit-scan").map((entry) => entry.ref),
    [semgrep.ref]
  );
  const blocked = (commitScan: unknown, overrides: Partial<ReleaseGateEvaluationInput> = {}) =>
    staleSemgrep(commitScan, overrides).blockers.map((entry) => [entry.code, entry.source]);
  const expected = [["defectdojo-scope-missing", "sast"]];
  assert.deepEqual(blocked(undefined), expected);
  assert.deepEqual(blocked({ commit: OLD_COMMIT, semgrep }), expected);
  assert.deepEqual(blocked({ commit: COMMIT, semgrep: { ...semgrep, severities: undefined } }), expected);
  assert.deepEqual(blocked({ commit: COMMIT, semgrep: { ...semgrep, status: "failure" } }), expected);
  assert.deepEqual(
    blocked({ commit: COMMIT, semgrep: { ...semgrep, severities: { ...CLEAN_COUNTS, critical: 1 } } }),
    expected
  );
  assert.deepEqual(
    blocked({ commit: COMMIT, semgrep: { ...semgrep, severities: { ...CLEAN_COUNTS, low: -1 } } }),
    expected
  );
  // The filesystem Trivy summary never proves the Semgrep scan type.
  assert.deepEqual(blocked({ commit: COMMIT, trivy: semgrep }), expected);
  // High counts only matter when the policy blocks High.
  const high = { commit: COMMIT, semgrep: { ...semgrep, severities: { ...CLEAN_COUNTS, high: 2 } } };
  assert.deepEqual(blocked(high), []);
  assert.deepEqual(blocked(high, { policy: parseReleaseGatePolicy('{"blockHigh":true}') }), expected);
});

test("a stale image import is proven only by a Critical-clean image scan under a Critical-only policy", () => {
  const tests: ReleaseDojoTest[] = [
    TESTS[0]!,
    { id: 2, engagement: 11, scan_type: "Trivy Scan", tags: tags("image", [], 99, OLD_COMMIT) }
  ];
  const result = (overrides: Partial<ReleaseGateEvaluationInput> = {}) =>
    evaluateReleaseGate(input({ defectDojo: dojo([finding({ id: 150, test: 2 })], [], tests), ...overrides }));
  assert.equal(result().decision, "pass");
  assert.deepEqual(
    result({ policy: parseReleaseGatePolicy('{"blockHigh":true}') }).blockers.map((entry) => [
      entry.code,
      entry.source
    ]),
    [["defectdojo-scope-missing", "image"]]
  );
});

test("findings already false-positive, duplicate, mitigated, or unverified do not block", () => {
  const result = evaluateReleaseGate(
    input({
      defectDojo: dojo([
        finding({ id: 130, false_p: true }),
        finding({ id: 131, duplicate: true }),
        finding({ id: 132, is_mitigated: true }),
        finding({ id: 133, verified: false }),
        finding({ id: 134, active: false })
      ])
    })
  );
  assert.equal(result.decision, "pass");
  assert.equal(result.ignoredFindings.notOpen, 5);
  const unverified = evaluateReleaseGate(
    input({ defectDojo: dojo([finding({ verified: false })]), policy: policy({ verifiedOnly: false }) })
  );
  assert.equal(unverified.decision, "fail");
});

test("policy parser keeps Critical and signature mandatory and rejects unknown fields", () => {
  assert.deepEqual(parseReleaseGatePolicy(undefined), DEFAULT_RELEASE_GATE_POLICY);
  assert.deepEqual(parseReleaseGatePolicy("  "), DEFAULT_RELEASE_GATE_POLICY);
  assert.deepEqual(
    parseReleaseGatePolicy('{"blockingSeverities":["high","critical"],"verifiedOnly":false}'),
    { ...DEFAULT_RELEASE_GATE_POLICY, blockingSeverities: ["critical", "high"], verifiedOnly: false }
  );
  for (const raw of [
    "[]",
    '{"blockingSeverities":["high"]}',
    '{"blockingSeverities":["critical","severe"]}',
    '{"requiredEvidence":["sbom"]}',
    '{"blockHigh":"yes"}',
    '{"aiApproves":true}',
    `{"blockHigh":true,"pad":"${"x".repeat(17_000)}"}`,
    "{"
  ]) {
    assert.throws(() => parseReleaseGatePolicy(raw), undefined, raw.slice(0, 40));
  }
});
