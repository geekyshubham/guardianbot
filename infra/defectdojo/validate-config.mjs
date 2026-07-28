#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { promisify } from "node:util";
import YAML from "yaml";

const STACK_DIR = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
const SOURCE_COMMIT_PLACEHOLDER = "$Format:%H$";

const EXPECTED_IMAGES = Object.freeze({
  django:
    "defectdojo/defectdojo-django:3.1.200@sha256:b2b7b00ef0d53b6a7dd0b12ed2f645bef42263aeef674144bddead2d78cf65ad",
  nginx:
    "defectdojo/defectdojo-nginx:3.1.200@sha256:322fc39b1dfcdb78a3bcbdc9b3b413e4e74b8853ff8ca484922289f58d3e1468",
  valkey:
    "valkey/valkey:9.1.0-alpine@sha256:a35428eba9043cc0b79dbe54100f0c92784f2de00ad09b01182bfb1c5c83d1bd",
  caddy:
    "caddy:2.11.4-alpine@sha256:98eb57d882ccd5213d1688764db10c1ca2c58a1ca3a6717a3411ad798f7a423a",
  postgresTools:
    "postgres:18.4-alpine@sha256:1b1689b20d16a014a3d195653381cf2caa75a41a92d93b255a9d6ea29fd353aa",
});

const REQUIRED_SERVICES = Object.freeze([
  "caddy",
  "nginx",
  "uwsgi",
  "celeryworker",
  "celerybeat",
  "initializer",
  "valkey",
  "operator",
  "postgres-tools",
]);

const DJANGO_SERVICES = Object.freeze([
  "uwsgi",
  "celeryworker",
  "celerybeat",
  "initializer",
  "operator",
]);

const STACK_DEFINITION_FILES = Object.freeze([
  "Caddyfile",
  "cloud-init.yml",
  "compose.yml",
  "scripts/apply-release.sh",
  "scripts/backup.sh",
  "scripts/doctor.sh",
  "scripts/generate-env.sh",
  "scripts/install-host.sh",
  "scripts/lib.sh",
  "scripts/preflight.sh",
  "scripts/pull-and-verify-images.sh",
  "scripts/restore-volume.py",
  "scripts/restore.sh",
  "scripts/verify-stack-definition.sh",
  "scripts/wait-ready.sh",
  "systemd/guardianbot-defectdojo-backup.service",
  "systemd/guardianbot-defectdojo-backup.timer",
  "systemd/guardianbot-defectdojo.service",
]);

async function sha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function assertImmutableAmd64Image(serviceName, service) {
  assert.equal(service.platform, "linux/amd64", `${serviceName} must force linux/amd64`);
  assert.match(
    service.image,
    /@sha256:[0-9a-f]{64}$/,
    `${serviceName} must use an immutable manifest digest`,
  );
  assert.equal(service.pull_policy, "always", `${serviceName} must refresh the immutable manifest`);
}

function hasCaMount(service) {
  return service.volumes.some((volume) => {
    if (typeof volume === "string") {
      return volume.includes("/run/secrets/do-postgres-ca.crt");
    }
    return (
      volume.source === "/etc/guardianbot/do-postgres-ca.crt" &&
      volume.target === "/run/secrets/do-postgres-ca.crt" &&
      volume.read_only === true
    );
  });
}

export async function validateDefectDojoConfig(stackDir = STACK_DIR) {
  const composePath = path.join(stackDir, "compose.yml");
  const caddyPath = path.join(stackDir, "Caddyfile");
  const cloudInitPath = path.join(stackDir, "cloud-init.yml");
  const manifestPath = path.join(stackDir, "release-manifest.json");
  const attributesPath = path.join(stackDir, ".gitattributes");
  const [
    composeSource,
    caddySource,
    cloudInitSource,
    manifestSource,
    attributesSource,
  ] = await Promise.all([
    readFile(composePath, "utf8"),
    readFile(caddyPath, "utf8"),
    readFile(cloudInitPath, "utf8"),
    readFile(manifestPath, "utf8"),
    readFile(attributesPath, "utf8"),
  ]);
  const compose = YAML.parse(composeSource, { merge: true });
  const cloudInit = YAML.parse(cloudInitSource);
  const manifest = JSON.parse(manifestSource);

  assert.deepEqual(Object.keys(compose.services).sort(), [...REQUIRED_SERVICES].sort());
  assert.equal(compose.services.postgres, undefined, "PostgreSQL must be DigitalOcean managed");
  assert.equal(compose.networks.app.internal, true, "the broker network must be internal");
  assert.equal(compose.services.caddy.image, EXPECTED_IMAGES.caddy);
  assert.equal(compose.services.nginx.image, EXPECTED_IMAGES.nginx);
  assert.equal(compose.services.valkey.image, EXPECTED_IMAGES.valkey);
  assert.equal(
    compose.services["postgres-tools"].image,
    EXPECTED_IMAGES.postgresTools,
  );

  for (const [serviceName, service] of Object.entries(compose.services)) {
    assertImmutableAmd64Image(serviceName, service);
    assert.ok(service.security_opt.includes("no-new-privileges:true"));
    assert.ok(service.cap_drop.includes("ALL"));
    if (
      serviceName !== "initializer" &&
      serviceName !== "operator" &&
      serviceName !== "postgres-tools"
    ) {
      assert.ok(service.healthcheck, `${serviceName} must have a healthcheck`);
    }
    if (serviceName !== "caddy") {
      assert.equal(service.ports, undefined, `${serviceName} must not publish a host port`);
    }
  }

  assert.deepEqual(compose.services.caddy.ports, [
    "80:80/tcp",
    "443:443/tcp",
    "443:443/udp",
  ]);
  assert.deepEqual(compose.services.operator.profiles, ["operator"]);
  assert.deepEqual(compose.services["postgres-tools"].profiles, ["operator"]);
  assert.equal(compose.services["postgres-tools"].ports, undefined);
  assert.equal(compose.services["postgres-tools"].command, undefined);
  assert.equal(
    compose.services["postgres-tools"].environment.PGSSLMODE,
    "verify-full",
  );
  assert.ok(hasCaMount(compose.services["postgres-tools"]));

  for (const serviceName of DJANGO_SERVICES) {
    const service = compose.services[serviceName];
    assert.equal(service.image, EXPECTED_IMAGES.django);
    assert.equal(service.environment.PGSSLMODE, "verify-full");
    assert.equal(service.environment.PGSSLROOTCERT, "/run/secrets/do-postgres-ca.crt");
    assert.equal(service.environment.DD_DATABASE_URL, undefined);
    assert.ok(hasCaMount(service), `${serviceName} must mount the managed PostgreSQL CA`);
  }

  for (const serviceName of ["uwsgi", "celeryworker", "celerybeat"]) {
    assert.equal(
      compose.services[serviceName].environment.DD_ADMIN_PASSWORD,
      undefined,
      `${serviceName} must not receive the bootstrap admin password`,
    );
    assert.equal(
      compose.services[serviceName].environment.DD_JIRA_WEBHOOK_SECRET,
      undefined,
      `${serviceName} must not receive the bootstrap JIRA secret`,
    );
  }
  assert.match(
    compose.services.initializer.environment.DD_ADMIN_PASSWORD,
    /^\$\{DD_ADMIN_PASSWORD:\?/,
  );
  assert.equal(compose.services.operator.environment.DD_SECRET_KEY, undefined);
  assert.equal(
    compose.services.operator.environment.DD_CREDENTIAL_AES_256_KEY,
    undefined,
  );

  assert.equal(manifest.defectdojoRelease, "3.1.200");
  assert.equal(manifest.schemaVersion, "1.0.0");
  assert.equal(manifest.platform, "linux/amd64");
  assert.deepEqual(manifest.images, EXPECTED_IMAGES);
  assert.deepEqual(manifest.guardianbotSource?.repository,
    "https://github.com/geekyshubham/guardianbot");
  assert.match(
    manifest.guardianbotSource?.commit,
    /^(?:\$Format:%H\$|[0-9a-f]{40})$/,
  );
  assert.equal(manifest.stackDefinition?.algorithm, "sha256");
  assert.deepEqual(
    Object.keys(manifest.stackDefinition?.files ?? {}).sort(),
    [...STACK_DEFINITION_FILES].sort(),
  );
  for (const relativePath of STACK_DEFINITION_FILES) {
    const expected = manifest.stackDefinition.files[relativePath];
    assert.match(expected, /^[0-9a-f]{64}$/);
    assert.equal(
      await sha256(path.join(stackDir, relativePath)),
      expected,
      `${relativePath} must match its release-manifest checksum`,
    );
  }
  assert.equal(
    attributesSource.trim(),
    "release-manifest.json export-subst",
    "git archives must substitute the exact GuardianBot source commit",
  );
  let sourceCommit = manifest.guardianbotSource.commit;
  if (sourceCommit === SOURCE_COMMIT_PLACEHOLDER) {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", stackDir, "rev-parse", "HEAD"],
      { encoding: "utf8" },
    );
    sourceCommit = stdout.trim();
  }
  assert.match(sourceCommit, /^[0-9a-f]{40}$/);

  const sshHardening = cloudInit.write_files.find(
    (entry) =>
      entry.path ===
      "/etc/ssh/sshd_config.d/99-guardianbot-defectdojo.conf",
  );
  assert.ok(sshHardening, "cloud-init must install the SSH hardening drop-in");
  assert.match(sshHardening.content, /^PermitRootLogin prohibit-password$/m);
  assert.doesNotMatch(sshHardening.content, /^PermitRootLogin no$/m);
  assert.notEqual(cloudInit.disable_root, true);
  assert.ok(cloudInit.runcmd.includes("ufw allow 443/tcp"));
  assert.ok(cloudInit.runcmd.includes("ufw allow 443/udp"));
  assert.ok(cloudInit.runcmd.includes("ufw --force enable"));

  assert.ok(!composeSource.includes("defectdojo:defectdojo"));
  assert.ok(!composeSource.includes("DD_DATABASE_URL"));
  assert.ok(!composeSource.includes("ghp_"));

  for (const endpoint of [
    "/django_metrics",
    "/nginx_health",
    "/nginx_status",
    "/uwsgi_health",
  ]) {
    assert.ok(caddySource.includes(endpoint), `Caddy must explicitly protect ${endpoint}`);
  }
  assert.ok(caddySource.includes("max_size 110MB"));
  assert.ok(caddySource.includes("output stdout"));

  const scripts = [
    "apply-release.sh",
    "backup.sh",
    "doctor.sh",
    "generate-env.sh",
    "install-host.sh",
    "preflight.sh",
    "pull-and-verify-images.sh",
    "restore.sh",
    "verify-stack-definition.sh",
    "wait-ready.sh",
  ];
  for (const script of scripts) {
    const metadata = await stat(path.join(stackDir, "scripts", script));
    assert.ok((metadata.mode & 0o111) !== 0, `${script} must be executable`);
  }

  return {
    release: manifest.defectdojoRelease,
    guardianbotSourceCommit: sourceCommit,
    services: Object.keys(compose.services),
    images: manifest.images,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await validateDefectDojoConfig();
  process.stdout.write(
    "DefectDojo deployment definition passed deterministic validation.\n",
  );
}
