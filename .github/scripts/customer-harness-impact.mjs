#!/usr/bin/env node
import console from "node:console";
import fs from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { COMPONENT_KINDS, validateHarnessImpactContract } from "./customer-harness-contract.mjs";

export const HARNESS_IMPACT_MARKER = /<!--\s*bench:customer-harness\s*([\s\S]*?)\s*-->/gi;

const REPOSITORY_RULES = Object.freeze({
  "BenchAGI/BenchAGI_Mono_Repo": Object.freeze([
    { pattern: /^apps\/agents\//, component: "harness-bundle" },
    { pattern: /^apps\/relay\/(?!__tests__\/)/, component: "relay" },
    { pattern: /^harness\//, component: "harness-bundle" },
    { pattern: /^scripts\/openclaw-harness-pull\.sh$/, component: "harness-bundle" },
    { pattern: /^tools\/aurelius-seat-kit\/(?!tests\/|docs\/|runbooks\/)/, component: "seat-kit" },
    {
      pattern: /^tools\/support-mesh-broker\/launchd\/com\.benchagi\.harness-pull/,
      component: "seat-kit",
    },
  ]),
  "BenchAGI/aurelius": Object.freeze([
    {
      pattern: /^skills\/slack-comprehension\/agent\/claude-agent-sdk\/(?!tests\/)/,
      component: "slack-sidecar",
    },
  ]),
  "BenchAGI/bench-harness": Object.freeze([
    { pattern: /^(?:bootstrap|sync)\.sh$/, component: "seat-kit" },
    { pattern: /^launchd\//, component: "seat-kit" },
    { pattern: /^scripts\/(?!.*(?:test|spec)\.)/, component: "seat-kit" },
    { pattern: /^workspace\//, component: "harness-bundle" },
  ]),
  "BenchAGI/openclaw": Object.freeze([
    { pattern: /^(?:src|packages|extensions|skills|patches|ui)\//, component: "openclaw" },
    {
      pattern:
        /^(?:openclaw\.mjs|package\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml)$/,
      component: "openclaw",
    },
    {
      pattern:
        /^scripts\/(?:(?:crabbox-wrapper|install-claude-code-bridge|npm-runner|prepare-git-hooks|preinstall-package-manager-warning|postinstall-bundled-plugins|windows-cmd-helpers)\.mjs|openclaw-prepack\.ts|ui\.js)$/,
      component: "openclaw",
    },
    {
      pattern:
        /^scripts\/lib\/(?:official-external-(?:channel|plugin|provider)-catalog\.json|package-dist-imports\.mjs)$/,
      component: "openclaw",
    },
  ]),
});

function markerMatches(body) {
  return [...String(body ?? "").matchAll(new RegExp(HARNESS_IMPACT_MARKER.source, "gi"))];
}

function parseDeclaration(body) {
  const values = String(body ?? "")
    .split(/\r?\n/)
    .map((line) => /^\s*-\s*Customer harness impact:\s*(.*?)\s*$/i.exec(line)?.[1])
    .filter((value) => value !== undefined);
  if (values.length === 0) return { value: null, found: false, errors: [] };
  if (values.length !== 1) {
    return {
      value: null,
      found: true,
      errors: [
        "Select exactly one Customer harness impact value in the PR description: Yes or No.",
      ],
    };
  }
  const value = values[0].trim().toLowerCase();
  if (!["yes", "no"].includes(value)) {
    return {
      value: null,
      found: true,
      errors: ["Customer harness impact must be exactly Yes or No."],
    };
  }
  return { value, found: true, errors: [] };
}

export function extractHarnessImpactContract(body) {
  const matches = markerMatches(body);
  if (matches.length === 0) return { found: false, contract: null, errors: [] };
  if (matches.length !== 1) {
    return {
      found: true,
      contract: null,
      errors: ["Use exactly one <!-- bench:customer-harness ... --> block."],
    };
  }
  try {
    const contract = JSON.parse(matches[0][1].trim());
    return { found: true, contract, errors: [] };
  } catch {
    return {
      found: true,
      contract: null,
      errors: ["The customer harness impact block must contain valid JSON."],
    };
  }
}

function evidenceOnlyPath(file) {
  const basename = file.split("/").at(-1) ?? "";
  return (
    /(?:^|\/)(?:__tests__|__snapshots__|test|tests|fixtures|docs|runbooks)\//.test(file) ||
    /\.snap$/.test(file) ||
    /(?:^|[._-])(?:test|spec)\.[^.]+$/.test(basename) ||
    /^README(?:\.[^.]+)?$/i.test(basename)
  );
}

export function classifyHarnessPaths({ repository, files }) {
  const rules = REPOSITORY_RULES[repository] ?? [];
  const matchedFiles = [];
  const components = new Set();
  for (const file of files ?? []) {
    const names = typeof file === "string" ? [file] : [file?.filename, file?.previous_filename];
    for (const name of names) {
      if (typeof name !== "string" || evidenceOnlyPath(name)) continue;
      for (const rule of rules) {
        if (!rule.pattern.test(name)) continue;
        matchedFiles.push(name);
        components.add(rule.component);
        break;
      }
    }
  }
  return {
    candidate: components.size > 0,
    components: [...components].sort(),
    matchedFiles: [...new Set(matchedFiles)].sort(),
  };
}

export function validatePullRequestHarnessImpact({ repository, body, files }) {
  const declaration = parseDeclaration(body);
  const extracted = extractHarnessImpactContract(body);
  const classified = classifyHarnessPaths({ repository, files });
  const errors = [...declaration.errors, ...extracted.errors];

  if (classified.candidate && !declaration.found) {
    errors.push("Customer-installed paths require an explicit Customer harness impact: Yes.");
  }
  if (declaration.value === "no" && extracted.found) {
    errors.push("A customer harness impact block conflicts with Customer harness impact: No.");
  }
  if (declaration.value === "yes" && !extracted.found) {
    errors.push("Customer harness impact: Yes requires one customer harness impact block.");
  }
  if (classified.candidate && declaration.value === "no") {
    errors.push(
      `Customer-installed paths require Customer harness impact: Yes (${classified.components.join(", ")}).`,
    );
  }

  let contractComponents = [];
  if (extracted.found && extracted.errors.length === 0) {
    const validation = validateHarnessImpactContract(extracted.contract);
    errors.push(...validation.errors);
    contractComponents = validation.components ?? [];
    for (const component of classified.components) {
      if (!contractComponents.includes(component)) {
        errors.push(`The impact contract must include detected component ${component}.`);
      }
    }
    for (const component of contractComponents) {
      if (!COMPONENT_KINDS.includes(component)) {
        errors.push(`Unsupported contract component ${component}.`);
      }
    }
  }

  return {
    valid: errors.length === 0,
    impact: declaration.value === "yes",
    contract: extracted.contract,
    detectedComponents: classified.components,
    matchedFiles: classified.matchedFiles,
    errors,
  };
}

export async function fetchPullRequestFiles({
  repository,
  pullNumber,
  token,
  fetchImpl = globalThis.fetch,
}) {
  if (!repository || !Number.isSafeInteger(pullNumber) || pullNumber < 1 || !token) {
    throw new Error("repository, pullNumber, and token are required to inspect PR files");
  }
  const files = [];
  for (let page = 1; page <= 30; page += 1) {
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}/pulls/${pullNumber}/files?per_page=100&page=${page}`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      },
    );
    if (!response.ok) throw new Error(`could not inspect PR files (GitHub ${response.status})`);
    const pageFiles = await response.json();
    if (!Array.isArray(pageFiles)) throw new Error("GitHub PR files response was not an array");
    files.push(
      ...pageFiles.map((file) => ({
        filename: file.filename,
        previous_filename: file.previous_filename,
      })),
    );
    if (pageFiles.length < 100) return files;
  }
  throw new Error("PR changed more than 3000 files; refusing an incomplete harness-impact scan");
}

export async function main(env = process.env) {
  if (env.GITHUB_EVENT_NAME === "merge_group") {
    console.log("merge-group harness-impact check: PR was validated before queue entry");
    return;
  }
  if (!["pull_request", "pull_request_target"].includes(env.GITHUB_EVENT_NAME)) {
    throw new Error(
      `Customer harness impact only supports pull_request, pull_request_target, or merge_group events, got ${env.GITHUB_EVENT_NAME || "none"}.`,
    );
  }
  if (!env.GITHUB_EVENT_PATH) throw new Error("GITHUB_EVENT_PATH is required.");
  const event = JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const pullRequest = event.pull_request;
  if (!pullRequest) throw new Error("pull_request payload is required.");
  const files = await fetchPullRequestFiles({
    repository: env.GITHUB_REPOSITORY,
    pullNumber: pullRequest.number,
    token: env.GITHUB_TOKEN,
  });
  const result = validatePullRequestHarnessImpact({
    repository: env.GITHUB_REPOSITORY,
    body: pullRequest.body,
    files,
  });
  if (!result.valid) {
    for (const error of result.errors) {
      console.error(`::error title=Customer harness impact::${error}`);
    }
    throw new Error(`Customer harness impact failed with ${result.errors.length} error(s).`);
  }
  console.log(
    result.impact
      ? `customer harness impact valid: ${result.contract.components.map((component) => component.kind).join(", ")}`
      : "customer harness impact classified No",
  );
}

const invokedPath = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
const modulePath = fs.realpathSync(fileURLToPath(import.meta.url));
if (invokedPath && invokedPath === modulePath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
