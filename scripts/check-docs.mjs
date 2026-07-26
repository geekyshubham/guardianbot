import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const required = [
  "README.md", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md",
  "docs/getting-started.md", "docs/onboarding-repositories.md",
  "docs/repository-configuration.md", "docs/commands.md",
  "docs/troubleshooting.md", "docs/status.md", "docs/how-it-works.md",
  "docs/architecture.md", "docs/model-protocol.md",
  "docs/building-a-model-bridge.md", "docs/security-model.md",
  "docs/scanning-and-policy.md", "docs/image-security.md", "docs/dast.md",
  "docs/defectdojo.md", "docs/operations.md", "docs/metrics.md", "docs/roadmap.md"
];
for (const file of required) {
  if (!fs.existsSync(path.join(root, file))) throw new Error(`Required documentation missing: ${file}`);
}
for (const file of required.filter((file) => file.endsWith(".md"))) {
  const source = fs.readFileSync(path.join(root, file), "utf8");
  for (const match of source.matchAll(/\[[^\]]+\]\((?!https?:|#)([^)]+)\)/g)) {
    const target = match[1].split("#")[0];
    if (!target) continue;
    const resolved = path.resolve(path.dirname(path.join(root, file)), target);
    if (!fs.existsSync(resolved)) throw new Error(`${file} links to missing ${target}`);
  }
  const opens = (source.match(/```mermaid/g) ?? []).length;
  if (opens && (source.match(/```/g) ?? []).length < opens * 2) {
    throw new Error(`${file} has an unclosed Mermaid block`);
  }
}
console.log(`Validated ${required.length} required documentation files and local links.`);
