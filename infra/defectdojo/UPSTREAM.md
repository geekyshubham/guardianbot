# Upstream compatibility record

This deployment was derived from the official DefectDojo OSS `3.1.200` tag,
commit `f2163b4f7618847ae6f61df336623d37548fdbfc`. The following source contracts
are intentionally preserved.

| Contract | Official source | GuardianBot behavior |
| --- | --- | --- |
| Compose evaluation topology and service entrypoints | [`docker-compose.yml`](https://github.com/DefectDojo/django-DefectDojo/blob/3.1.200/docker-compose.yml) | Keeps Nginx, uWSGI, Celery worker, Celery beat, initializer, and Valkey entrypoints. Replaces the evaluation PostgreSQL service with DigitalOcean Managed PostgreSQL. |
| Database component settings | [`settings.dist.py`](https://github.com/DefectDojo/django-DefectDojo/blob/3.1.200/dojo/settings/settings.dist.py) | Uses supported `DD_DATABASE_ENGINE`, `DD_DATABASE_HOST`, `DD_DATABASE_NAME`, `DD_DATABASE_PASSWORD`, `DD_DATABASE_PORT`, and `DD_DATABASE_USER` values. |
| Reverse-proxy and HTTPS settings | [`settings.dist.py`](https://github.com/DefectDojo/django-DefectDojo/blob/3.1.200/dojo/settings/settings.dist.py) | Enables `DD_SECURE_PROXY_SSL_HEADER`, secure cookies, HTTPS redirect, trusted CSRF origin, and HSTS behind Caddy. |
| Idempotent migrations/bootstrap | [`complete_initialization.py`](https://github.com/DefectDojo/django-DefectDojo/blob/3.1.200/dojo/management/commands/complete_initialization.py) | Runs the one-shot initializer before runtime services. It applies migrations every release and creates the administrator only when missing. |
| Runtime database/broker readiness | [`entrypoint-uwsgi.sh`](https://github.com/DefectDojo/django-DefectDojo/blob/3.1.200/docker/entrypoint-uwsgi.sh), [`entrypoint-celery-worker.sh`](https://github.com/DefectDojo/django-DefectDojo/blob/3.1.200/docker/entrypoint-celery-worker.sh), and [`entrypoint-celery-beat.sh`](https://github.com/DefectDojo/django-DefectDojo/blob/3.1.200/docker/entrypoint-celery-beat.sh) | Uses the official entrypoints after a bounded host/port wait. |
| Upstream health paths | [`nginx.conf`](https://github.com/DefectDojo/django-DefectDojo/blob/3.1.200/nginx/nginx.conf) | Uses `/uwsgi_health` internally and exposes a separate Caddy `/healthz`; upstream health/metrics paths return 404 publicly. |
| Persistent media location | [`Dockerfile.django-debian`](https://github.com/DefectDojo/django-DefectDojo/blob/3.1.200/Dockerfile.django-debian) | Shares the stable `guardianbot_defectdojo_media` volume between uWSGI, workers, and Nginx. |

## Deliberate production changes

- A dedicated DigitalOcean Managed PostgreSQL 18 cluster replaces the local
  database container.
- libpq enforces `verify-full` with the cluster CA.
- Caddy supplies public ACME TLS; upstream Nginx stays private and uses HTTP only
  inside the Docker network.
- The operator profile uses a pinned PostgreSQL 18.4 client for dump/restore
  compatibility but never starts a database server.
- Images, resources, capabilities, published ports, logs, healthchecks, and
  restart behavior are explicit.
- Valkey is isolated on an internal network and treated as a replayable broker.
- Backup/restore, systemd lifecycle, preflight, live diagnostics, and immutable
  release validation are supplied outside upstream's evaluation Compose file.
