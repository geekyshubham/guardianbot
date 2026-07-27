# Building a model bridge

A bridge translates `guardian.review.v1` into any local or hosted model API. The
control plane, protocol, repository configuration, and reusable workflows contain
no provider SDK, provider URL grammar, model name, or provider credential. Those
details are isolated inside a separately deployable bridge; the included bridge is
one conforming implementation, not a control-plane dependency.

Implementation checklist:

1. Return capabilities with strict structured-output support and allowed data
   classifications.
2. Map administrative profiles such as `routine-review`, `high-risk-review`, and
   `benchmark-review` to backend aliases outside repository configuration.
3. Treat every context string as untrusted data, never instructions.
4. Give the model no tools, credentials, GitHub access, or control-plane network.
5. Apply native strict structured output when supported; otherwise declare the
   bridge non-conforming.
6. Return exactly the canonical result shape.

Run:

```sh
npm test --workspace @guardianbot/protocol
npm run typecheck --workspace @guardianbot/protocol
```

Then replay the protocol fixtures against the bridge and verify malformed output,
stale SHA, duplicate fingerprints, unchanged lines, timeout, and refusal cases are
rejected. Fallback must be absent unless an administrator approves both repository
classification and the alternate backend.
