import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { validateDefectDojoConfig } from "../infra/defectdojo/validate-config.mjs";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dirname, "..");
const STACK = path.join(ROOT, "infra", "defectdojo");

test("the DefectDojo deployment is immutable and DigitalOcean-only", async () => {
  const result = await validateDefectDojoConfig(STACK);
  assert.equal(result.release, "3.1.200");
  assert.deepEqual(result.services.sort(), [
    "caddy",
    "celerybeat",
    "celeryworker",
    "initializer",
    "nginx",
    "operator",
    "postgres-tools",
    "uwsgi",
    "valkey",
  ]);
});

test("operator shell scripts parse successfully", async () => {
  const scriptsDirectory = path.join(STACK, "scripts");
  const scripts = [
    "apply-release.sh",
    "backup.sh",
    "doctor.sh",
    "generate-env.sh",
    "install-host.sh",
    "lib.sh",
    "preflight.sh",
    "pull-and-verify-images.sh",
    "restore.sh",
    "wait-ready.sh",
  ];
  for (const script of scripts) {
    await execFileAsync("bash", ["-n", path.join(scriptsDirectory, script)]);
  }
});

test("restore helper exposes only fixed volume targets", async () => {
  const source = await readFile(
    path.join(STACK, "scripts", "restore-volume.py"),
    "utf8",
  );
  for (const target of ["media", "valkey", "caddy-data", "caddy-config"]) {
    assert.ok(source.includes(`"${target}": Path("/restore/${target}")`));
  }
  assert.ok(source.includes('filter="data"'));
  assert.ok(!source.includes("extractall(destination)"));
});

test("systemd units preserve data and use the root-owned env file", async () => {
  const unit = await readFile(
    path.join(STACK, "systemd", "guardianbot-defectdojo.service"),
    "utf8",
  );
  assert.ok(unit.includes("--env-file /etc/guardianbot/defectdojo.env"));
  assert.ok(unit.includes("scripts/preflight.sh"));
  assert.ok(unit.includes("scripts/wait-ready.sh"));
  assert.ok(!unit.includes(" down "));
  assert.ok(!unit.includes("--volumes"));
});
