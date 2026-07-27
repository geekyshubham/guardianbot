#!/usr/bin/env node

import {
  DocumentationCheckError,
  formatDocumentationReport,
  runDocumentationChecks
} from "./docs-check-lib.mjs";

const root = process.cwd();
const checkExternalLinks = process.argv.includes("--external");

try {
  const report = await runDocumentationChecks({ root, checkExternalLinks });
  console.log(formatDocumentationReport(report));
} catch (error) {
  if (error instanceof DocumentationCheckError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
