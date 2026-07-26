# Onboarding repositories

App installation creates a repository record keyed by GitHub repository ID,
inspects the default branch read-only, and opens an onboarding issue. Scanner
coverage remains `not configured`.

`guardianctl onboard OWNER/REPOSITORY` detects Python, Node, Swift, Ruby,
lockfiles, Dockerfiles, OpenAPI, CODEOWNERS, test commands, health endpoints, and
PostgreSQL/Redis hints. It validates and writes only:

- `.guardianbot/config.yml`
- `.guardianbot/onboarding.md`
- `.github/workflows/guardianbot.yml`

It creates one draft PR. The workflow calls GuardianBot at an immutable commit.
No scanner implementation or infrastructure credential enters the repository.

For a known staging contract, operators may supply reusable declarative overrides:
`--dockerfile`, `--health-path`, `--readiness-path`, `--dast-origin`, `--openapi`,
`--auth-profile`, and `--session-path`. GuardianBot validates that the Dockerfile
exists and requires the complete DAST tuple; none of these flags accepts a secret.

Lifecycle commands:

```sh
guardianctl doctor OWNER/REPOSITORY
guardianctl enforce OWNER/REPOSITORY
guardianctl upgrade OWNER/REPOSITORY
guardianctl inventory
guardianctl offboard OWNER/REPOSITORY
```

`doctor` validates configuration, workflow pin, and latest expected run.
`enforce` refuses to act until diagnostics are healthy and then creates the
required-check ruleset using operator authorization. `upgrade` opens a pin update
PR. `offboard` opens a deletion PR and deliberately retains central audit evidence.

Current limitation: `upgrade --all` and automatic seven-day transition reporting
are planned; inventory supplies the discovery input in the PoC.
