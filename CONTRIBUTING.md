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
