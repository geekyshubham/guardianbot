# GuardianBot GitHub App

The control plane uses a private, installation-scoped GitHub App. Consumer
repositories receive access through App installation; they do not receive the
App private key, webhook secret, model credentials, scanner credentials, or
DefectDojo credentials.

## Required App settings

Use the settings in [`config/github-app-manifest.json`](../config/github-app-manifest.json).
Replace `YOUR_GUARDIANBOT_HOST` with the HTTPS DigitalOcean origin before
creating the App. The manifest intentionally does not configure a setup or
redirect URL because the current control plane has no browser setup callback;
installation is completed through GitHub's installation page and webhook
events. The webhook URL is:

```text
https://YOUR_GUARDIANBOT_HOST/webhooks/github
```

The App is private and should be installed only on explicitly selected
repositories. Required repository permissions are:

| Permission | Access | Purpose |
| --- | --- | --- |
| Metadata | Read | Repository identity and default branch |
| Contents | Read | Indexing source, manifests, workflows, and CODEOWNERS |
| Actions | Read | Reusable-workflow run and evidence reconciliation |
| Issues | Read and write | Onboarding issues and review status |
| Pull requests | Read and write | Reviews, comments, suggestions, and onboarding PRs |

Subscribe to `installation`, `installation_repositories`, `repository`,
`push`, `pull_request`, `issue_comment`, `issues`, and `workflow_run` events.
Do not grant Administration, Secrets, Variables, Deployments, or Packages
permission to the App. `guardianctl enforce` uses the operator's ordinary
GitHub authorization for rulesets.

## DigitalOcean secret placement

Store the generated App ID, private key, and webhook secret only as encrypted
environment values on the DigitalOcean control-plane service or droplet. Set:

```text
GITHUB_APP_ID=...
GITHUB_APP_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----
GITHUB_WEBHOOK_SECRET=...
```

The private key must never be committed, placed in a repository secret, sent to
the model bridge, or included in workflow artifacts. Rotate the webhook secret
and App key according to the operations runbook if either is exposed.

## Installation verification

After App creation and installation, verify:

1. `GET /healthz` returns `200`.
2. `GET /readyz` returns `200` after the worker and database are ready.
3. Installing on a test repository creates an isolated repository record and
   an onboarding issue.
4. `guardianctl doctor OWNER/REPOSITORY` reports App access and the expected
   workflow identity.

The App can be created from GitHub's **Settings → Developer settings → GitHub
Apps → New GitHub App** page. GitHub may request sudo-mode password
re-authentication before allowing the form to be submitted.
