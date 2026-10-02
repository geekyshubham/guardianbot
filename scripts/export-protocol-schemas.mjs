import fs from "node:fs";
import path from "node:path";
import {
  backendCapabilitiesSchema,
  remediationValidationRequestSchema,
  remediationValidationResultSchema,
  reviewRequestSchema,
  reviewResultSchema
} from "../packages/protocol/dist/schemas.js";

const definitions = [
  ["review-request.v1.json", "GuardianBot Review Request", reviewRequestSchema],
  ["review-result.v1.json", "GuardianBot Review Result", reviewResultSchema],
  ["backend-capabilities.v1.json", "GuardianBot Backend Capabilities", backendCapabilitiesSchema],
  [
    "remediation-validation-request.v1.json",
    "GuardianBot Remediation Validation Request",
    remediationValidationRequestSchema
  ],
  [
    "remediation-validation-result.v1.json",
    "GuardianBot Remediation Validation Result",
    remediationValidationResultSchema
  ]
];
const check = process.argv.includes("--check");
for (const [name, title, schema] of definitions) {
  const output = `${JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title,
    ...schema
  }, null, 2)}\n`;
  const target = path.join(process.cwd(), "schemas", name);
  if (check) {
    if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== output) {
      throw new Error(`${name} is stale; run npm run schemas:generate`);
    }
  } else {
    fs.writeFileSync(target, output);
  }
}
console.log(`${check ? "Checked" : "Generated"} ${definitions.length} canonical protocol schemas.`);
