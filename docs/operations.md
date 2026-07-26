# Operations

Deploy the Compose stack on a dedicated DigitalOcean droplet or private VPC.
Caddy terminates TLS; PostgreSQL and Valkey have no public network. Monitor
`/healthz`, `/readyz`, `/metrics`, webhook error rates, review latency, index age,
scanner runs, imports, suppression expiry, and missing evidence.

Upgrade by pinning a GuardianBot release commit, backing up PostgreSQL, building the
new image, running migrations, and rolling the control plane. `guardianctl upgrade`
delivers consumer workflow pins through draft PRs.

Back up PostgreSQL and DefectDojo media to a DigitalOcean Space or encrypted
droplet volume; test restore into an isolated DigitalOcean environment. Rotate App
PEM, webhook secret, model bridge token, DefectDojo token, and staging credentials
independently. Emergency disablement removes App access or stops the control plane;
repository security workflows continue at their pinned commit.
