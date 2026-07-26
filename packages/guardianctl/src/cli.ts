#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  doctor,
  enforce,
  inventory,
  offboard,
  onboard,
  upgrade,
  upgradeAll,
  type CommandContext
} from "./index.js";
import { GitHubClient } from "@guardianbot/core";

function help(): never {
  console.log(`guardianctl <command> [OWNER/REPOSITORY] [options]

Commands:
  onboard       Detect a repository and open one draft onboarding PR
  doctor        Verify configuration, workflow pin, and latest expected run
  enforce       Create the required guardianbot/security-gate ruleset
  upgrade       Open a draft PR updating the immutable workflow pin; use --all for every onboarded repository
  inventory     List owned repositories and GuardianBot state
  offboard      Open a draft PR removing repository-side callers

Options:
  --dry-run     Inspect or render without writing to GitHub
  --json        Emit JSON
  --dockerfile PATH
  --health-path PATH
  --readiness-path PATH
  --dast-origin HTTPS_ORIGIN
  --openapi PATH_OR_URL
  --auth-profile CONTROL_PLANE_REFERENCE
  --session-path PROTECTED_PATH
  --help        Show this help

Authentication uses GH_TOKEN or the active gh CLI account. No repository secrets are created.`);
  process.exit(0);
}

function token(): string {
  if (process.env.GH_TOKEN) return process.env.GH_TOKEN;
  try {
    return execFileSync("gh", ["auth", "token"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    throw new Error("Authenticate with `gh auth login` or set GH_TOKEN");
  }
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help") || args.includes("-h")) help();
  const command = args[0]!;
  const repository = args.find((arg, index) => index > 0 && !arg.startsWith("-"));
  const context: CommandContext = {
    github: new GitHubClient(token()),
    guardianRepository: process.env.GUARDIANBOT_REPOSITORY ?? "Geekyshubham/guardianbot",
    workflowSha: process.env.GUARDIANBOT_WORKFLOW_SHA ?? "0000000000000000000000000000000000000000",
    dryRun: args.includes("--dry-run"),
    overrides: {
      dockerfile: option(args, "--dockerfile"),
      healthPath: option(args, "--health-path"),
      readinessPath: option(args, "--readiness-path"),
      dastOrigin: option(args, "--dast-origin"),
      openapi: option(args, "--openapi"),
      authenticationProfile: option(args, "--auth-profile"),
      sessionAssertionPath: option(args, "--session-path")
    }
  };
  if (context.workflowSha === "0000000000000000000000000000000000000000" && command !== "inventory") {
    throw new Error("Set GUARDIANBOT_WORKFLOW_SHA to the published immutable GuardianBot commit");
  }
  let result: unknown;
  if (command === "inventory") result = await inventory(context);
  else if (command === "upgrade" && args.includes("--all")) result = await upgradeAll(context);
  else {
    if (!repository) throw new Error(`${command} requires OWNER/REPOSITORY`);
    if (command === "onboard") result = await onboard(context, repository);
    else if (command === "doctor") result = await doctor(context, repository);
    else if (command === "enforce") result = await enforce(context, repository);
    else if (command === "upgrade") result = await upgrade(context, repository);
    else if (command === "offboard") result = await offboard(context, repository);
    else throw new Error(`Unknown command: ${command}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(`guardianctl: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
