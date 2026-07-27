import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const scripts = [
  "scripts/deploy-digitalocean.sh",
  "scripts/deploy-digitalocean-app-platform.sh"
];

for (const script of scripts) {
  test(`${script} passes Bash syntax validation`, async () => {
    const source = await readFile(path.resolve(script), "utf8");
    const checked = spawnSync("bash", ["-n"], {
      input: source,
      encoding: "utf8"
    });
    assert.equal(checked.status, 0, checked.stderr);
  });
}

test("droplet deployment requires canonical signed release assets", async () => {
  const source = await readFile(
    path.resolve("scripts/deploy-digitalocean.sh"),
    "utf8"
  );
  assert.match(source, /release-evidence\.mjs verify-assets/);
  assert.match(source, /release-evidence\.mjs verify-manifest/);
  assert.match(source, /cosign verify-blob/);
  assert.match(source, /cosign verify-attestation/);
  assert.match(source, /gh attestation verify/);
  assert.match(source, /verify_stack "\$GUARDIANBOT_IMAGE"/);
  assert.doesNotMatch(source, /rm -rf/);
});

test("App Platform deployment verifies the active immutable digest", async () => {
  const source = await readFile(
    path.resolve("scripts/deploy-digitalocean-app-platform.sh"),
    "utf8"
  );
  assert.match(source, /release-evidence\.mjs verify-assets/);
  assert.match(source, /\.name == "guardianbot-prod"/);
  assert.match(source, /--deployment "\$active_deployment"/);
  assert.match(source, /\.image\.digest == \$digest/);
  assert.match(source, /\/healthz/);
  assert.match(source, /\/readyz/);
});
