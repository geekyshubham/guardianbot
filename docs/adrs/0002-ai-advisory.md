# ADR 0002: AI findings are advisory

Status: Accepted.

Model output can be useful but is nondeterministic and processes hostile text.
Therefore even valid P0 output cannot block. Semgrep, Trivy, evidence completeness,
and explicit policy own the merge gate.
