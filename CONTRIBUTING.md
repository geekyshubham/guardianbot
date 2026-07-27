# Contributing

Use Node 22 and run:

```sh
npm install
npm run check
```

Changes to public CLI commands, schemas, protocol fields, scanner policy, or
capability behavior require corresponding documentation, `docs/status.md`, and
`CHANGELOG.md` updates. Add contract tests for protocol changes and fixtures for
normalizers. Never add provider SDKs, provider-specific model configuration, or
repository credentials.

Pull requests should explain threat impact, backward compatibility, failure
behavior, and verification evidence.

## Documentation checks

`npm run check` validates every Markdown file, local paths and heading anchors,
annotated YAML/JSON configuration examples, the config field reference, OpenAPI
examples, Mermaid-to-SVG rendering, and `guardianctl` help smoke commands. It also
compares capability-changing diffs with `docs/status.md` and `CHANGELOG.md`; CI
therefore needs the pull request base commit available in the checkout.

Mermaid rendering is browserless and currently accepts the renderer's flowchart,
state, sequence, class, entity-relationship, and XY chart families. Unsupported
diagram families fail the gate instead of receiving syntax-only validation.

Normal CI checks external URLs for valid HTTP(S) structure but deliberately make
no live network requests. Run `npm run docs:check:external` when curating links to
add bounded live reachability checks. HTTP 401, 403, 405, and 429 responses count
as reachable endpoints; other 4xx/5xx responses and network failures are reported.
Keeping the live check opt-in prevents transient remote outages and rate limits
from blocking unrelated builds.
