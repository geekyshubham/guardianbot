# DefectDojo on DigitalOcean

Use the upstream DefectDojo Docker Compose release on the same DigitalOcean VPC or
droplet, pinning its release tag and image digests. Configure `DEFECTDOJO_URL` and
`DEFECTDOJO_API_TOKEN` only in the GuardianBot control-plane environment. Consumer
repositories never receive these values.

GuardianBot maps one DefectDojo product per GitHub repository, engagements by scan
type and branch, and reimports using stable scanner fingerprints. Keep DefectDojo's
PostgreSQL and object storage self-hosted on DigitalOcean for this PoC.
