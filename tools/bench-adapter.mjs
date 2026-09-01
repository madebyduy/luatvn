// Measures how far the file-backed adapter goes before a database is needed.
// Document shapes come from real vbpl.vn measurements taken on 2026-09-01:
//   circular -> 8 provisions, ~170 characters each (measured over 2 documents)
//   law      -> 218 provisions, ~1412 characters each (Luat Doanh nghiep 59/2020/QH14)
// The generated corpus is 95% circulars and 5% laws. These are startup numbers
// for this machine and this Node version, not a production SLO.
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";

import {
  decodeManualDatasetFile,
  ManualDatasetRepository,
  maximumProvisionVersionRecords,
} from "@luatvn/manual-dataset";

const releaseId = "rel_bench_corpus";
const timeBudgetMs = 120_000;

function textOf(length, seed) {
  const unit = `Noi dung dieu khoan so ${seed} phuc vu do luong tai nguyen. `;
  return unit.repeat(Math.max(1, Math.ceil(length / unit.length))).slice(0, length);
}

function documentRecords(documentIndex, provisionCount, textLength) {
  const evidenceId = `ev_bench_d${documentIndex}`;
  const provisions = [];
  for (let index = 0; index < provisionCount; index += 1) {
    const legalText = textOf(textLength, `${documentIndex}-${index}`);
    provisions.push({
      datasetReleaseId: releaseId,
      documentId: `doc_bench_d${documentIndex}`,
      documentNumber: `${documentIndex}/2020/TT-BENCH`,
      evidence: [
        {
          evidenceId,
          locator: null,
          officialSourceUrl: `https://vbpl.vn/van-ban/chi-tiet/bench-${documentIndex}`,
          retrievedAt: "2026-09-01T00:00:00.000Z",
          sourceSha256: createHash("sha256").update(`bench-${documentIndex}`).digest("hex"),
        },
      ],
      heading: `Điều ${index + 1}. Muc do luong`,
      legalText,
      legalTextSha256: createHash("sha256").update(legalText, "utf8").digest("hex"),
      primaryEvidenceId: evidenceId,
      provisionId: `prov_bench_d${documentIndex}p${index}`,
      provisionVersionId: `pv_bench_d${documentIndex}p${index}`,
      reviewStatus: "verified",
      systemTime: { from: "2026-09-01T00:00:00.000Z", to: null },
      validTime: { from: "2020-01-01", to: null },
    });
  }
  return provisions;
}

function buildCorpus(documentCount) {
  const provisionVersions = [];
  for (let index = 0; index < documentCount; index += 1) {
    const isLaw = index % 20 === 0;
    provisionVersions.push(...documentRecords(index, isLaw ? 218 : 8, isLaw ? 1412 : 170));
  }
  return { amendments: [], datasetReleaseId: releaseId, provisionVersions, schemaVersion: 1 };
}

function heapMb() {
  return process.memoryUsage().heapUsed / 1024 / 1024;
}

const sizes = [100, 500, 2000, 5000, 20000];
const directory = await mkdtemp(join(tmpdir(), "luatvn-bench-"));

process.stdout.write(
  `${"documents".padStart(10)} ${"provisions".padStart(11)} ${"file MB".padStart(8)} ${"parse+decode s".padStart(15)} ${"index s".padStart(8)} ${"heap MB".padStart(8)}  schema\n`,
);

try {
  for (const documentCount of sizes) {
    const corpus = buildCorpus(documentCount);
    let text;
    try {
      text = JSON.stringify(corpus);
    } catch {
      // V8 caps string length, so one release cannot be serialised into a
      // single JSON file beyond this size. That is a structural wall, not a
      // memory shortage: the release format itself has to change.
      process.stdout.write(
        `${String(documentCount).padStart(10)} ${String(corpus.provisionVersions.length).padStart(11)}  cannot serialise one release into a single JSON file
`,
      );
      break;
    }
    // eslint-disable-next-line no-await-in-loop -- each size is measured in sequence on purpose
    await writeFile(join(directory, `corpus-${String(documentCount)}.json`), text, "utf8");
    const fileMb = Buffer.byteLength(text) / 1024 / 1024;

    global.gc?.();
    const heapBefore = heapMb();

    const decodeStart = performance.now();
    const parsed = JSON.parse(text);
    const decoded = decodeManualDatasetFile(parsed);
    const decodeSeconds = (performance.now() - decodeStart) / 1000;

    const overCap = !decoded.ok;
    if (overCap && corpus.provisionVersions.length <= maximumProvisionVersionRecords) {
      process.stderr.write("decode failed for a reason other than the record cap\n");
      process.exitCode = 1;
      break;
    }

    const indexStart = performance.now();
    const repository = new ManualDatasetRepository({
      dataset: decoded.ok ? decoded.value : parsed,
      datasetReleaseId: releaseId,
    });
    const indexSeconds = (performance.now() - indexStart) / 1000;
    void repository;
    const heapUsedMb = heapMb() - heapBefore;

    process.stdout.write(
      `${String(documentCount).padStart(10)} ${String(corpus.provisionVersions.length).padStart(11)} ${fileMb.toFixed(1).padStart(8)} ${decodeSeconds.toFixed(2).padStart(15)} ${indexSeconds.toFixed(2).padStart(8)} ${heapUsedMb.toFixed(0).padStart(8)}  ${overCap ? "OVER CAP" : "ok"}\n`,
    );

    if ((decodeSeconds + indexSeconds) * 1000 > timeBudgetMs) {
      process.stdout.write("stopping: startup cost exceeded the measurement budget\n");
      break;
    }
  }
} finally {
  await rm(directory, { force: true, recursive: true });
}
