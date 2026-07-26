import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const schemas = fs.readdirSync(path.join(root, "schemas")).filter((name) => name.endsWith(".json"));
if (!schemas.length) throw new Error("No schemas found");
for (const name of schemas) {
  const value = JSON.parse(fs.readFileSync(path.join(root, "schemas", name), "utf8"));
  if (!value.$schema || !value.$id) throw new Error(`${name} must declare $schema and $id`);
}
console.log(`Validated ${schemas.length} JSON schemas.`);
