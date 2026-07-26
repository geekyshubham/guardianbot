## GuardianBot onboarding

Repository: `geekyshubham/guardianbot`

| Capability | Detection |
| --- | --- |
| Languages | `dockerfile`, `javascript`, `typescript` |
| Package managers | `npm` |
| Lockfiles | `package-lock.json` |
| Dockerfiles | `Dockerfile` |
| OpenAPI | None detected |

### Rollout

- Scanner mode starts as **report-only**.
- Existing findings form the initial baseline.
- Enforcement is enabled separately after the observation period.
- GuardianBot infrastructure and model credentials are not copied into this repository.

### Notes

- DAST requires an OpenAPI artifact or explicit crawl profile.
- No CODEOWNERS file detected; reviewer suggestions will use history.
