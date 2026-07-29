# RouteLens and AstraNull isolated staging

This definition runs the exact signed RouteLens and AstraNull images on one
DigitalOcean staging Droplet without changing either production deployment.
Each application has a separate internal Docker network and PostgreSQL
database; only RouteLens can reach its Redis instance. Caddy is the sole
publicly exposed component.

The checked image references are immutable digests produced by the generic
GuardianBot default-branch promotion workflow. `deploy.sh` applies migrations
through those same images before starting them. Runtime secrets are generated
on the host by `generate-env.sh`, stored mode `0600`, and never committed.

Example host setup:

```sh
install -d -m 755 /opt/guardianbot-staging /etc/guardianbot
./scripts/generate-env.sh \
  /etc/guardianbot/staging.env \
  routelens-staging.example.com \
  astranull-staging.example.com
./scripts/deploy.sh
```

The operator must authenticate Docker to GHCR centrally before deployment when
an image is private. Consumer repositories receive no registry, DigitalOcean,
database, model, DAST, or DefectDojo credential.

This stack proves exact-image staging and runtime isolation. It does not by
itself prove deployment-bound GuardianBot reconciliation, authenticated ZAP,
or DefectDojo import; those require accepted control-plane profiles and workflow
evidence for the same digest and origin.
