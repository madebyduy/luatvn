import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import process from "node:process";

import {
  buildSourceStoreManifest,
  decodeManualDatasetFile,
  decodeSourceStoreManifest,
  getPublishedPointer,
  loadPublishedRelease,
  promoteRecordToVerified,
  publishRelease,
  ReleaseStoreError,
  ReviewError,
  rollbackPublishedRelease,
  stripByteOrderMark,
  validateReleaseForPublish,
  verifySourceStoreManifest,
} from "@luatvn/manual-dataset";

const usage = `Usage:
  pnpm dataset validate <staging-file.json> [--data-dir <dir>]
  pnpm dataset review   <staging-file.json>
  pnpm dataset promote  <staging-file.json> (--version <pv_id> | --amendment <amd_id>) --reviewed-by "<full name>"
  pnpm dataset publish  <staging-file.json> --reviewed-by "<full name>" [--data-dir <dir>]
  pnpm dataset sources  [--verify] [--dir <sources-dir>] [--manifest <manifest.json>]
  pnpm dataset rollback [--data-dir <dir>]
  pnpm dataset status   [--data-dir <dir>]

The default data directory is data/manual. See docs/08-operator-runbook.md.
promote is the only path that raises a record to verified; it appends an audit
entry to <staging-file>.review-log.json.
sources rebuilds data/manual/sources-manifest.json from the local source store
(ADR-0005: the files themselves never enter git); --verify checks the store
against the committed manifest and exits 1 on any difference.`;

function out(line) {
  process.stdout.write(`${line}\n`);
}

function fail(line) {
  process.stderr.write(`${line}\n`);
  process.exitCode = 1;
}

function printStoreError(error) {
  fail(`${error.code}: ${error.message}`);
  for (const issue of error.issues) {
    fail(`  - ${issue.locator}: ${issue.message}`);
  }
}

const booleanFlags = new Set(["verify"]);

function parseArguments(argv) {
  const positional = [];
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith("--")) {
      if (booleanFlags.has(argument.slice(2))) {
        flags.set(argument.slice(2), "true");
        continue;
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Flag ${argument} requires a value`);
      }
      flags.set(argument.slice(2), value);
      index += 1;
    } else {
      positional.push(argument);
    }
  }
  return { positional, flags };
}

async function runValidate(file, dataDirectory) {
  const text = stripByteOrderMark(await readFile(file, "utf8"));
  let parsedJson;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    fail("DATASET_PARSE_FAILED: staging file is not valid JSON");
    return;
  }
  const decoded = decodeManualDatasetFile(parsedJson);
  if (!decoded.ok) {
    fail("DATASET_INVALID: staging file does not match the dataset schema");
    for (const issue of decoded.issues) {
      fail(`  - ${issue.path}: ${issue.message}`);
    }
    return;
  }
  const issues = validateReleaseForPublish(decoded.value, { now: new Date().toISOString() });
  if (issues.length > 0) {
    fail(`RELEASE_VALIDATION_FAILED: ${issues.length} record-level failure(s)`);
    for (const issue of issues) {
      fail(`  - ${issue.locator}: ${issue.message}`);
    }
    return;
  }
  out(
    `validation passed: release ${decoded.value.datasetReleaseId}, ` +
      `${decoded.value.provisionVersions.length} provision version(s), ` +
      `${decoded.value.amendments.length} amendment(s) (data dir: ${dataDirectory})`,
  );
}

async function runReview(file) {
  const text = stripByteOrderMark(await readFile(file, "utf8"));
  const decoded = decodeManualDatasetFile(JSON.parse(text));
  if (!decoded.ok) {
    fail("DATASET_INVALID: staging file does not match the dataset schema");
    for (const issue of decoded.issues) {
      fail(`  - ${issue.path}: ${issue.message}`);
    }
    return;
  }
  const dataset = decoded.value;
  let underReview = 0;
  for (const version of dataset.provisionVersions) {
    if (version.reviewStatus !== "verified") underReview += 1;
    out(
      `${version.reviewStatus.padEnd(12)} ${version.provisionVersionId}  ${version.heading ?? ""}`,
    );
  }
  for (const amendment of dataset.amendments) {
    if (amendment.reviewStatus !== "verified") underReview += 1;
    out(`${amendment.reviewStatus.padEnd(12)} ${amendment.amendmentId}`);
  }
  out(
    `release ${dataset.datasetReleaseId}: ${dataset.provisionVersions.length} version(s), ` +
      `${dataset.amendments.length} amendment(s), ${underReview} awaiting review`,
  );
}

async function runPromote(file, flags) {
  const text = await readFile(file, "utf8");
  const input = { datasetText: text, reviewedBy: flags.get("reviewed-by") ?? "" };
  const version = flags.get("version");
  const amendment = flags.get("amendment");
  if (version !== undefined) input.provisionVersionId = version;
  if (amendment !== undefined) input.amendmentId = amendment;

  const result = promoteRecordToVerified(input);
  await writeFile(file, result.updatedDatasetText, "utf8");

  const logPath = `${file}.review-log.json`;
  let auditLog = [];
  try {
    const existing = JSON.parse(await readFile(logPath, "utf8"));
    if (Array.isArray(existing)) auditLog = existing;
  } catch {
    // First promotion for this staging file.
  }
  auditLog.push(result.audit);
  await writeFile(logPath, `${JSON.stringify(auditLog, null, 2)}\n`, "utf8");

  out(`promoted ${result.audit.target} to verified`);
  out(`  reviewed by: ${result.audit.reviewedBy} at ${result.audit.reviewedAt}`);
  out(`  audit log: ${logPath}`);
}

const defaultSourcesDirectory = join("data", "manual", "sources");
const defaultSourcesManifest = join("data", "manual", "sources-manifest.json");

async function scanSourceFiles(directory) {
  let entries;
  try {
    entries = await readdir(directory, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !path.endsWith("README.md"));
  return Promise.all(
    files.map(async (path) => {
      const bytes = await readFile(path);
      return {
        byteLength: bytes.byteLength,
        path: relative(directory, path).split(sep).join("/"),
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  );
}

async function runSources(flags, verify) {
  const directory = flags.get("dir") ?? defaultSourcesDirectory;
  const manifestPath = flags.get("manifest") ?? defaultSourcesManifest;
  const actual = await scanSourceFiles(directory);

  if (!verify) {
    const built = buildSourceStoreManifest(actual, new Date().toISOString());
    if (!built.ok) {
      fail("MANIFEST_INVALID: could not build the source manifest");
      for (const issue of built.issues) fail(`  - ${issue.path}: ${issue.message}`);
      return;
    }
    await writeFile(
      manifestPath,
      `${JSON.stringify(built.value, null, 2)}
`,
      "utf8",
    );
    const totalBytes = actual.reduce((sum, file) => sum + file.byteLength, 0);
    out(
      `source manifest written: ${manifestPath} (${actual.length} file(s), ` +
        `${(totalBytes / 1024 / 1024).toFixed(1)} MB in ${directory})`,
    );
    return;
  }

  let manifestJson;
  try {
    manifestJson = JSON.parse(stripByteOrderMark(await readFile(manifestPath, "utf8")));
  } catch {
    fail(`MANIFEST_UNREADABLE: ${manifestPath} is missing or not valid JSON`);
    return;
  }
  const decoded = decodeSourceStoreManifest(manifestJson);
  if (!decoded.ok) {
    fail("MANIFEST_INVALID: source manifest does not match the schema");
    for (const issue of decoded.issues) fail(`  - ${issue.path}: ${issue.message}`);
    return;
  }
  const issues = verifySourceStoreManifest(decoded.value, actual);
  if (issues.length > 0) {
    fail(`SOURCE_STORE_MISMATCH: ${issues.length} difference(s) against ${manifestPath}`);
    for (const issue of issues) fail(`  - ${issue.code} ${issue.path}: ${issue.message}`);
    return;
  }
  out(`source store verified: ${actual.length} file(s) match ${manifestPath}`);
}

async function runPublish(file, dataDirectory, reviewedBy) {
  if (reviewedBy === undefined) {
    fail('publish requires --reviewed-by "<full name>" naming the human reviewer');
    return;
  }
  const text = await readFile(file, "utf8");
  const published = await publishRelease(dataDirectory, text, { reviewedBy });
  out(`published release ${published.datasetReleaseId} to ${dataDirectory}`);
}

async function runRollback(dataDirectory) {
  const rolledBack = await rollbackPublishedRelease(dataDirectory);
  out(`rolled back: current release is now ${rolledBack.restoredReleaseId}`);
}

async function runStatus(dataDirectory) {
  const pointer = await getPublishedPointer(dataDirectory);
  out(`current release: ${pointer.currentReleaseId}`);
  out(`previous releases: ${pointer.previousReleaseIds.join(", ") || "(none)"}`);
  out(`updated at: ${pointer.updatedAt}`);
  const release = await loadPublishedRelease(dataDirectory);
  out(
    `integrity verified: ${release.dataset.provisionVersions.length} provision version(s), ` +
      `${release.dataset.amendments.length} amendment(s), reviewed by ${release.manifest.reviewedBy}`,
  );
}

async function run() {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArguments(rest);
  const dataDirectory = flags.get("data-dir") ?? "data/manual";

  switch (command) {
    case "validate": {
      if (positional[0] === undefined) throw new Error(usage);
      await runValidate(positional[0], dataDirectory);
      return;
    }
    case "review": {
      if (positional[0] === undefined) throw new Error(usage);
      await runReview(positional[0]);
      return;
    }
    case "promote": {
      if (positional[0] === undefined) throw new Error(usage);
      await runPromote(positional[0], flags);
      return;
    }
    case "publish": {
      if (positional[0] === undefined) throw new Error(usage);
      await runPublish(positional[0], dataDirectory, flags.get("reviewed-by"));
      return;
    }
    case "sources": {
      await runSources(flags, flags.get("verify") === "true");
      return;
    }
    case "rollback": {
      await runRollback(dataDirectory);
      return;
    }
    case "status": {
      await runStatus(dataDirectory);
      return;
    }
    default: {
      throw new Error(usage);
    }
  }
}

run().catch((error) => {
  if (error instanceof ReleaseStoreError) {
    printStoreError(error);
    return;
  }
  if (error instanceof ReviewError) {
    fail(`${error.code}: ${error.message}`);
    return;
  }
  fail(error instanceof Error ? error.message : "Unknown dataset CLI error");
});
