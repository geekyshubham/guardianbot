import assert from "node:assert/strict";
import {
  appendFile,
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
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

test("Valkey can initialize its persistent volume with only its required capabilities", async () => {
  const compose = await readFile(path.join(STACK, "compose.yml"), "utf8");
  assert.match(
    compose,
    /valkey:[\s\S]*?cap_drop:\s*-\s*ALL[\s\S]*?cap_add:\s*-\s*CHOWN\s*-\s*SETGID\s*-\s*SETUID[\s\S]*?no-new-privileges:true/,
  );
});

test("stack-definition validation rejects a changed operational file", async () => {
  const temporaryRoot = await mkdtemp(
    path.join(tmpdir(), "guardianbot-defectdojo-definition-"),
  );
  const copyPath = path.join(temporaryRoot, "defectdojo");
  try {
    await cp(STACK, copyPath, { recursive: true });
    const manifestPath = path.join(copyPath, "release-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.guardianbotSource.commit = "0".repeat(40);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await validateDefectDojoConfig(copyPath);
    await appendFile(path.join(copyPath, "Caddyfile"), "\n# drift\n");
    await assert.rejects(
      () => validateDefectDojoConfig(copyPath),
      /must match its release-manifest checksum/,
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
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
    "verify-stack-definition.sh",
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
