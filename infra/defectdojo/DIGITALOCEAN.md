# DigitalOcean boundary

This deployment intentionally has one infrastructure boundary: DigitalOcean.
The scripts in this directory do not provision resources, call cloud APIs, or
read operator credentials. An authorized operator creates the following
resources in DigitalOcean before installation.

## Compute and network

- x86_64 Droplet, minimum 4 vCPU and 8 GiB RAM.
- Same region and VPC as the dedicated PostgreSQL cluster.
- Reserved IP used by one DigitalOcean DNS `A` record.
- DigitalOcean Cloud Firewall:
  - TCP 80 from all clients for ACME redirects.
  - TCP 443 from all clients.
  - UDP 443 from all clients for HTTP/3, or omit it and remove the Compose UDP
    mapping when HTTP/3 is not desired.
  - TCP 22 only from explicit operator source addresses.
  - no inbound rules for 3031, 6379, 8080, 8081, or PostgreSQL.

The host firewall must not contradict the Cloud Firewall. Do not automatically
change SSH policy from an unattended install script; validate the operator
allowlist first.

## PostgreSQL

- Dedicated DigitalOcean Managed PostgreSQL 18 cluster.
- Dedicated `defectdojo` database and least-privilege owner user.
- Private cluster hostname where DigitalOcean provides one.
- Trusted sources limited to the Droplet/VPC.
- Cluster CA installed as `/etc/guardianbot/do-postgres-ca.crt`.
- Automated DigitalOcean backups enabled and a restore drill scheduled.

The Compose definition passes individual `DD_DATABASE_*` settings rather than a
connection URL. libpq is forced to `verify-full` and receives the mounted CA.
`doctor.sh` queries `pg_stat_ssl` through Django and fails unless the active
session uses TLS.

## DNS and TLS

Create the `A` record before starting the systemd service. Caddy obtains and
renews a public certificate automatically. The hostname and ACME email are
non-secret entries in `/etc/guardianbot/defectdojo.env`.

Keep `/var/lib/docker`, `/var/backups/guardianbot/defectdojo`, and the named
Docker volumes on encrypted DigitalOcean storage. Replicate encrypted logical
backups to a second DigitalOcean-controlled failure domain before declaring the
deployment production-ready.

Useful platform references:

- [Cloud Firewall rules](https://docs.digitalocean.com/products/networking/firewalls/how-to/configure-rules/)
- [PostgreSQL trusted sources](https://docs.digitalocean.com/products/databases/postgresql/how-to/secure/)
- [PostgreSQL backups and point-in-time recovery](https://docs.digitalocean.com/products/databases/postgresql/how-to/restore-from-backups/)
