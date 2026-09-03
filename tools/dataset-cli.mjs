import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import process from "node:process";

import { verifyReleaseChain } from "@luatvn/ingest";

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
  pnpm dataset queue    <staging-file.json> [--sample 0.05] [--seed 1]
  pnpm dataset promote  <staging-file.json> (--version <pv_id> | --amendment <amd_id>) --reviewed-by "<full name>"
  pnpm dataset publish  <staging-file.json> --reviewed-by "<full name>" [--data-dir <dir>] [--sources-dir <dir>]
  pnpm dataset verify   [--data-dir <dir>] [--allow-hosts h1,h2]
  pnpm dataset sources  [--verify] [--dir <sources-dir>] [--manifest <manifest.json>]
  pnpm dataset backup   --to <dir> [--data-dir <dir>] [--verify-only]
  pnpm dataset rollback [--data-dir <dir>]
  pnpm dataset status   [--data-dir <dir>]

The default data directory is data/manual. See docs/08-operator-runbook.md.
queue lists what a reviewer should read: every record the cross-checks flagged
or could not run on, plus a seeded random sample of machine_checked records so
the checker itself stays honest. Reads <staging-file>.checks.json written by
"pnpm ingest congbao".
promote is the only path that raises a record to verified; it appends an audit
entry to <staging-file>.review-log.json.
verify re-derives the legal text of the published release from the sources
archived inside it and compares the hashes. It proves the text came from that
archived source and that a named reviewer vouched for each record; it does not
prove the source itself states the law correctly.
backup copies the shared evidence archive to another disk and checks every
copied file against its own digest. The archive is the one part of the data
that git does not carry (ADR-0005/0007), so losing the disk loses it; owner
decision 2026-09-03 (ADR-0008 STO-001) is that a backup is required, with the
location and schedule chosen by whoever runs it. --verify-only compares an
existing backup without writing.
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

const booleanFlags = new Set(["verify", "verify-only"]);

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

// Deterministic sampling: the same seed always picks the same records, so a
// second reviewer can reproduce which ones were spot-checked.
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

async function runQueue(file, flags) {
  const text = stripByteOrderMark(await readFile(file, "utf8"));
  const decoded = decodeManualDatasetFile(JSON.parse(text));
  if (!decoded.ok) {
    fail("DATASET_INVALID: staging file does not match the dataset schema");
    return;
  }
  const dataset = decoded.value;
  let checks = null;
  try {
    checks = JSON.parse(await readFile(`${file}.checks.json`, "utf8"));
  } catch {
    out("không có file đối soát cạnh staging; liệt kê mọi record chưa duyệt");
  }
  const sampleRate = Number(flags.get("sample") ?? "0.05");
  const seed = Number(flags.get("seed") ?? "1");
  const random = seededRandom(seed);

  const mustRead = [];
  const sampled = [];
  for (const version of dataset.provisionVersions) {
    if (version.reviewStatus === "verified") continue;
    if (version.reviewStatus === "under_review" || version.reviewStatus === "unverified") {
      mustRead.push(version);
      continue;
    }
    // machine_checked: sample deterministically
    if (random() < sampleRate) sampled.push(version);
  }

  if (checks !== null) {
    out(`đối soát tài liệu ${checks.documentNumber}:`);
    for (const result of checks.results) {
      const mark = result.status === "pass" ? "ĐẠT " : result.status === "flag" ? "CỜ  " : "CHƯA";
      out(`  ${mark} ${String(result.check).padEnd(18)} ${result.detail}`);
    }
    out("");
  }
  out(`CẦN NGƯỜI XEM (${String(mustRead.length)}):`);
  for (const version of mustRead) {
    const why =
      checks !== null && checks.flaggedProvisionVersionIds.includes(version.provisionVersionId)
        ? "đánh số đứt trong Điều này"
        : checks !== null && !checks.allPassed
          ? `đối soát tài liệu chưa đạt: ${[...checks.flagged, ...checks.notAvailable].join(", ")}`
          : "chưa qua đối soát";
    out(`  ${version.provisionVersionId}  ${(version.heading ?? "").slice(0, 60)}`);
    out(`      → ${why}`);
  }
  out("");
  out(
    `MẪU KIỂM NGẪU NHIÊN (${String(sampled.length)} trong số machine_checked, tỉ lệ ${String(sampleRate)}, seed ${String(seed)}):`,
  );
  for (const version of sampled) {
    out(`  ${version.provisionVersionId}  ${(version.heading ?? "").slice(0, 60)}`);
  }
  const machineChecked = dataset.provisionVersions.filter(
    (version) => version.reviewStatus === "machine_checked",
  ).length;
  out("");
  out(
    `tổng: ${String(dataset.provisionVersions.length)} Điều - ${String(machineChecked)} machine_checked, ${String(mustRead.length)} cần người, ${String(sampled.length)} mẫu. Người duyệt đọc ${String(mustRead.length + sampled.length)} thay vì ${String(dataset.provisionVersions.length)}.`,
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

async function scanSourceFilePaths(directory) {
  let entries;
  try {
    entries = await readdir(directory, { recursive: true, withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((filePath) => !filePath.endsWith("README.md") && !filePath.endsWith(".evidence.json"));
}

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

async function readReviewLog(stagingFile) {
  try {
    const parsed = JSON.parse(await readFile(`${stagingFile}.review-log.json`, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Attaches exactly the archived files whose bytes hash to an evidence hash used
// by the dataset. Matching by hash rather than by file name means a renamed or
// substituted archive simply fails to match instead of being trusted.
async function collectArchivedSources(datasetText, sourcesDirectory) {
  let dataset;
  try {
    dataset = JSON.parse(stripByteOrderMark(datasetText));
  } catch {
    return [];
  }
  const wanted = new Set();
  for (const record of [...(dataset.provisionVersions ?? []), ...(dataset.amendments ?? [])]) {
    for (const evidence of record.evidence ?? []) {
      if (typeof evidence.sourceSha256 === "string") wanted.add(evidence.sourceSha256);
    }
  }
  if (wanted.size === 0) return [];

  const files = await scanSourceFilePaths(sourcesDirectory);
  const attached = [];
  const usedNames = new Set();
  for (const filePath of files) {
    // eslint-disable-next-line no-await-in-loop -- hashing candidate archives one at a time keeps memory flat on large source stores
    const bytes = await readFile(filePath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (!wanted.has(sha256)) continue;
    let name = filePath.split(sep).pop() ?? sha256;
    if (usedNames.has(name)) name = `${sha256.slice(0, 12)}-${name}`;
    usedNames.add(name);
    attached.push({ bytes, path: name });
  }
  return attached;
}

async function runPublish(file, dataDirectory, reviewedBy, flags) {
  if (reviewedBy === undefined) {
    fail('publish requires --reviewed-by "<full name>" naming the human reviewer');
    return;
  }
  const text = await readFile(file, "utf8");
  const sourcesDirectory = flags.get("sources-dir") ?? defaultSourcesDirectory;
  const sources = await collectArchivedSources(text, sourcesDirectory);
  const reviewLog = await readReviewLog(file);

  const published = await publishRelease(dataDirectory, text, {
    reviewLog,
    reviewedBy,
    sources,
  });
  out(`published release ${published.datasetReleaseId} to ${dataDirectory}`);
  out(`  archived sources bundled: ${sources.length}`);
  out(`  reviewer entries bundled: ${reviewLog.length}`);
  if (sources.length === 0) {
    out(
      "  note: no archived source matched this dataset, so pnpm dataset verify cannot re-derive its text",
    );
  }
}

async function runVerify(dataDirectory, flags) {
  const loadOptions = { includeAttachments: true };
  const allowHosts = flags.get("allow-hosts");
  if (allowHosts !== undefined) {
    loadOptions.allowedHosts = allowHosts.split(",").map((host) => host.trim().toLowerCase());
    out(`allow-hosts override active (drill/test only): ${loadOptions.allowedHosts.join(", ")}`);
  }
  const release = await loadPublishedRelease(dataDirectory, loadOptions);
  const report = await verifyReleaseChain(release);

  out(`verifying release ${release.datasetReleaseId}`);
  out(`  provisions: ${release.dataset.provisionVersions.length}`);
  out(`  archived sources: ${report.archivedSources}`);
  out(`  provisions re-derived from an archived source: ${report.derivedProvisions}`);
  out(`  provisions vouched for by a named reviewer: ${report.vouchedProvisions}`);

  if (report.issues.length > 0) {
    fail(`VERIFICATION_FAILED: ${report.issues.length} broken link(s)`);
    for (const issue of report.issues) {
      fail(`  ${issue.code} ${issue.locator}: ${issue.message}`);
    }
    return;
  }
  out("chain intact: every record re-derives from its archived source and carries a reviewer");
  out("note: this proves derivation and review, not that the source states the law correctly");
}

async function runBackup(dataDirectory, flags) {
  const target = flags.get("to");
  if (target === undefined) {
    throw new Error(usage);
  }
  const verifyOnly = flags.get("verify-only") === "true";
  const archiveDirectory = join(dataDirectory, "archive");
  let names;
  try {
    names = (await readdir(archiveDirectory)).filter((name) => !name.startsWith("."));
  } catch {
    fail(`ARCHIVE_MISSING: không có thư mục ${archiveDirectory} để sao lưu`);
    return;
  }
  if (!verifyOnly) {
    await mkdir(target, { recursive: true });
  }

  let copied = 0;
  let alreadyThere = 0;
  let mismatched = 0;
  let missing = 0;
  let bytes = 0;
  for (const name of names) {
    const digest = name.split(".")[0] ?? "";
    // eslint-disable-next-line no-await-in-loop -- one file at a time keeps memory flat on a large archive
    const source = await readFile(join(archiveDirectory, name));
    bytes += source.length;
    // The file is named by its own hash, so a corrupt original is caught here
    // rather than copied faithfully into the backup.
    if (createHash("sha256").update(source).digest("hex") !== digest) {
      fail(`  HỎNG NGUỒN  ${name}: nội dung không khớp mã băm trong tên file`);
      mismatched += 1;
      continue;
    }
    const destination = join(target, name);
    let existing = null;
    try {
      // eslint-disable-next-line no-await-in-loop -- see above
      existing = await readFile(destination);
    } catch {
      existing = null;
    }
    if (existing !== null) {
      if (createHash("sha256").update(existing).digest("hex") === digest) {
        alreadyThere += 1;
        continue;
      }
      fail(`  HỎNG BẢN SAO ${name}: bản sao lưu khác nội dung nguồn`);
      mismatched += 1;
      continue;
    }
    if (verifyOnly) {
      fail(`  THIẾU        ${name}: bản sao lưu chưa có file này`);
      missing += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- see above
    await writeFile(destination, source);
    copied += 1;
  }

  out(`kho nguồn: ${String(names.length)} file, ${(bytes / 1e6).toFixed(1)} MB`);
  out(`  đã có sẵn ở bản sao lưu : ${String(alreadyThere)}`);
  out(
    verifyOnly
      ? `  thiếu ở bản sao lưu    : ${String(missing)}`
      : `  chép mới               : ${String(copied)}`,
  );
  out(`  lệch mã băm            : ${String(mismatched)}`);
  out(`  đích: ${target}`);
  if (mismatched > 0 || missing > 0) {
    fail("sao lưu CHƯA đầy đủ hoặc có file lệch; xử lý từng dòng ở trên rồi chạy lại");
    return;
  }
  out("bản sao lưu khớp từng byte với kho nguồn.");
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
    case "queue": {
      if (positional[0] === undefined) throw new Error(usage);
      await runQueue(positional[0], flags);
      return;
    }
    case "publish": {
      if (positional[0] === undefined) throw new Error(usage);
      await runPublish(positional[0], dataDirectory, flags.get("reviewed-by"), flags);
      return;
    }
    case "verify": {
      await runVerify(dataDirectory, flags);
      return;
    }
    case "sources": {
      await runSources(flags, flags.get("verify") === "true");
      return;
    }
    case "backup": {
      await runBackup(dataDirectory, flags);
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
