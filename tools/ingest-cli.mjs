import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import {
  loadPublishedRelease,
  markRecordMachineChecked,
  ReviewError,
} from "@luatvn/manual-dataset";
import { extractPdfLines, PdfTextError } from "@luatvn/pdf-text";

import {
  checkExtraction,
  crossCheckCongBao,
  discoverLinkEntries,
  CongBaoExtractError,
  CongBaoPageError,
  extractCongBaoDraft,
  readCongBaoDetailPage,
  crawlIncremental,
  detectProvisionDrift,
  DocumentFetcher,
  emptyIngestState,
  extractVbplDraft,
  extractVbplRelations,
  vbplDocumentIdFromUrl,
  fetchVbplContentFlight,
  fetchVbplRelationsFlight,
  IngestError,
  ingestStateSchema,
  linkAmendments,
  mergeDrafts,
  MergeDraftsError,
  relationEvidenceFrom,
  vbplDetailUrl,
  VbplExtractError,
} from "@luatvn/ingest";

const usage = `Usage:
  pnpm ingest fetch <url> [--out <dir>] [--allow-hosts h1,h2] [--min-interval-ms n]
  pnpm ingest draft <detail-url> --release <rel_id> --out <staging.json>
                    [--with-amendments] [--sources-dir <dir>] [--content-action <id>]
                    [--relations-action <id>] [--allow-hosts h1,h2]
  pnpm ingest crawl --seeds <url1,url2> --pattern <regex> --state <state.json>
                    --out <dir> --max <n> [--allow-hosts h1,h2] [--min-interval-ms n]
  pnpm ingest drift <detail-url> [--data-dir <dir>] [--content-action <id>]
  pnpm ingest congbao <detail-url> --release <rel_id> --out <staging.json>
                    [--sources-dir <dir>] [--allow-hosts h1,h2] [--no-machine-check]
  pnpm ingest congbao-batch --seeds <url1,url2> --release <rel_id> --out <staging.json>
                    [--max n] [--state <state.json>] [--sources-dir <dir>]

fetch: store one document plus .evidence.json (URL, SHA-256, retrievedAt).
draft: fetch a vbpl.vn detail payload and extract an under_review staging draft
       for human review (docs/08-operator-runbook.md). --with-amendments also
       reads the relation graph, drafts each amended/replaced target document and
       links provision-level amendment drafts.
NOTE: original-document files ("Van ban goc"/"Tai ve") sit behind a CAPTCHA and
      are never fetched automatically - download those by hand.
drift: re-fetch a document and compare it against the published release. It
       proves the source changed, not that either side is legally correct.
congbao: read a congbao.chinhphu.vn detail page, fetch the signed PDF it points
       at, and extract an under_review draft from the PDF text layer. The page
       itself carries no legal text. A document whose effective date the gazette
       leaves blank is refused, not guessed.
congbao-batch: crawl a little, store a little. Discovers detail pages from the
       seed listings, ingests up to --max documents not handled before, merges
       them into one staging file, runs the six cross-checks on each and raises
       what passes to machine_checked. Refusals are recorded with their reason
       so they are not retried forever. Re-run to continue where it stopped.
crawl: fetch seed pages, follow same-host links matching the pattern within the
       budget; unchanged documents (same SHA-256) produce no new evidence.
--allow-hosts replaces the registered host list (SR-003) for drills/tests only.`;

function out(line) {
  process.stdout.write(`${line}\n`);
}

function fail(line) {
  process.stderr.write(`${line}\n`);
  process.exitCode = 1;
}

const booleanFlags = new Set(["with-amendments", "no-machine-check"]);

function parseArguments(argv) {
  const positional = [];
  const flags = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith("--")) {
      const name = argument.slice(2);
      if (booleanFlags.has(name)) {
        flags.set(name, "true");
        continue;
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`Flag ${argument} requires a value`);
      }
      flags.set(name, value);
      index += 1;
    } else {
      positional.push(argument);
    }
  }
  return { flags, positional };
}

function fetcherOptionsFrom(flags) {
  const options = {};
  const allowHosts = flags.get("allow-hosts");
  if (allowHosts !== undefined) {
    options.allowedHosts = allowHosts.split(",").map((host) => host.trim().toLowerCase());
    out(`allow-hosts override active (drill/test only): ${options.allowedHosts.join(", ")}`);
  }
  const minIntervalMs = flags.get("min-interval-ms");
  if (minIntervalMs !== undefined) {
    options.minIntervalMs = Number(minIntervalMs);
  }
  return options;
}

function extensionFor(contentType, url) {
  const type = (contentType ?? "").toLowerCase();
  if (type.includes("application/pdf")) return "pdf";
  if (type.includes("text/html")) return "html";
  if (type.includes("text/x-component")) return "rsc.txt";
  if (type.includes("text/plain")) return "txt";
  if (type.includes("application/json")) return "json";
  const match = /\.([a-z0-9]{1,5})(?:$|\?)/iu.exec(new URL(url).pathname);
  return match === null ? "bin" : match[1].toLowerCase();
}

async function storeDocument(document, outputDirectory, url) {
  await mkdir(outputDirectory, { recursive: true });
  const baseName = document.sourceSha256.slice(0, 12);
  const fileName = `${baseName}.${extensionFor(document.contentType, url)}`;
  await writeFile(join(outputDirectory, fileName), document.bytes);
  const evidence = {
    byteLength: document.byteLength,
    contentType: document.contentType,
    locator: null,
    officialSourceUrl: document.officialSourceUrl,
    retrievedAt: document.retrievedAt,
    sourceSha256: document.sourceSha256,
  };
  await writeFile(
    join(outputDirectory, `${baseName}.evidence.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );
  return fileName;
}

async function runFetch(url, flags) {
  const outputDirectory = flags.get("out") ?? join("data", "manual", "sources", "incoming");
  const fetcher = new DocumentFetcher(fetcherOptionsFrom(flags));
  const document = await fetcher.fetchDocument(url);
  const fileName = await storeDocument(document, outputDirectory, url);
  out(`fetched ${document.officialSourceUrl}`);
  out(`  content-type: ${document.contentType ?? "(none)"}, bytes: ${document.byteLength}`);
  out(`  sha256: ${document.sourceSha256}`);
  out(`  retrievedAt: ${document.retrievedAt}`);
  out(`  stored: ${join(outputDirectory, fileName)}`);
}

async function runDraft(detailUrl, flags, withAmendments) {
  const datasetReleaseId = flags.get("release");
  const stagingPath = flags.get("out");
  if (datasetReleaseId === undefined || stagingPath === undefined) {
    throw new Error(usage);
  }
  const sourcesDirectory =
    flags.get("sources-dir") ?? join("data", "manual", "sources", "incoming");
  const fetcher = new DocumentFetcher(fetcherOptionsFrom(flags));
  const contentAction = flags.get("content-action");
  const relationsAction = flags.get("relations-action");

  const draftOne = async (url) => {
    const payload =
      contentAction === undefined
        ? await fetchVbplContentFlight(fetcher, url)
        : await fetchVbplContentFlight(fetcher, url, contentAction);
    const storedName = await storeDocument(payload, sourcesDirectory, url);
    const extracted = extractVbplDraft(Buffer.from(payload.bytes).toString("utf8"), {
      datasetReleaseId,
      evidence: {
        officialSourceUrl: payload.officialSourceUrl,
        retrievedAt: payload.retrievedAt,
        sourceSha256: payload.sourceSha256,
      },
    });
    return { extracted, payloadBytes: payload.bytes, storedName };
  };

  const primary = await draftOne(detailUrl);
  const drafts = [primary.extracted.draft];
  const amendments = [];
  const unlinkedAll = [];
  let relationSummary = "";

  if (withAmendments) {
    const relationsPayload =
      relationsAction === undefined
        ? await fetchVbplRelationsFlight(fetcher, detailUrl)
        : await fetchVbplRelationsFlight(fetcher, detailUrl, relationsAction);
    await storeDocument(relationsPayload, sourcesDirectory, detailUrl);
    const { relations, unmapped } = extractVbplRelations(
      Buffer.from(relationsPayload.bytes).toString("utf8"),
    );
    relationSummary = `${relations.length} relation(s), ${unmapped.length} unmapped code(s)`;
    for (const unknown of unmapped) {
      out(
        `  unmapped relation code ${unknown.code} with ${unknown.documentCount} document(s) - a human must classify it`,
      );
    }

    const evidence = relationEvidenceFrom({
      officialSourceUrl: relationsPayload.officialSourceUrl,
      retrievedAt: relationsPayload.retrievedAt,
      sourceDocumentId: primary.extracted.report.sourceDocumentId,
      sourceSha256: relationsPayload.sourceSha256,
    });
    const effectiveFrom = primary.extracted.draft.provisionVersions[0].validTime.from;

    for (const relation of relations) {
      out(
        `  relation: ${relation.relationType} -> ${relation.targetSourceId} ${relation.targetName.slice(0, 60)}`,
      );
      // eslint-disable-next-line no-await-in-loop -- sequential fetching keeps the per-host rate limit honest
      const target = await draftOne(vbplDetailUrl(relation.targetSourceId));
      drafts.push(target.extracted.draft);
      const linked = linkAmendments({
        amendingProvisions: primary.extracted.draft.provisionVersions,
        effectiveFrom,
        evidence,
        relationType: relation.relationType,
        targetProvisions: target.extracted.draft.provisionVersions,
      });
      amendments.push(...linked.amendments);
      unlinkedAll.push(...linked.unlinked);
    }
  }

  const merged = mergeDrafts(drafts, amendments);
  if (!merged.ok) {
    fail("DRAFT_INVALID: merged staging draft does not match the dataset schema");
    for (const issue of merged.issues) {
      fail(`  - ${issue.path}: ${issue.message}`);
    }
    return;
  }
  await writeFile(
    stagingPath,
    `${JSON.stringify(merged.value, null, 2)}
`,
    "utf8",
  );

  const assurance = checkExtraction(
    Buffer.from(primary.payloadBytes).toString("utf8"),
    primary.extracted.draft.provisionVersions,
  );

  const report = primary.extracted.report;
  out(`draft written: ${stagingPath}`);
  out(`  document: ${report.documentNumber} (${report.title.slice(0, 80)})`);
  out(`  source id: ${report.sourceDocumentId}, payload stored: ${primary.storedName}`);
  out(`  effective from: ${report.effectiveFrom}, status at source: ${report.effectiveStatus}`);
  out(`  provisions in release: ${merged.value.provisionVersions.length} (all under_review)`);
  if (withAmendments) {
    out(`  relations: ${relationSummary}; amendment drafts: ${merged.value.amendments.length}`);
    for (const unlinked of unlinkedAll) {
      out(`  not linked: ${unlinked.locator} - ${unlinked.reason}`);
    }
  }
  for (const skip of report.skipped) {
    out(`  skipped: ${skip.locator} - ${skip.reason}`);
  }
  if (assurance.length === 0) {
    out("  assurance: source paragraphs fully covered, article numbering consistent");
  } else {
    for (const issue of assurance) {
      out(`  ASSURANCE ${issue.code} ${issue.locator}: ${issue.message}`);
    }
  }
  out(`next: pnpm dataset review ${stagingPath}`);
}

function secondExtractionOf(pdfPath) {
  const spawned = spawnSync("pdftotext", ["-layout", "-enc", "UTF-8", pdfPath, "-"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (spawned.error !== undefined || spawned.status !== 0 || typeof spawned.stdout !== "string") {
    return null;
  }
  return spawned.stdout;
}

async function appendReviewLog(stagingPath, entries) {
  const logPath = `${stagingPath}.review-log.json`;
  let existing = [];
  try {
    existing = JSON.parse(await readFile(logPath, "utf8"));
  } catch {
    existing = [];
  }
  await writeFile(logPath, `${JSON.stringify([...existing, ...entries], null, 2)}\n`, "utf8");
}

// One gazette document, from detail page to a cross-checked draft. Shared by
// the single-document command and the incremental batch, so both take exactly
// the same path and neither can drift into a softer set of checks.
async function ingestOneCongBaoDocument(fetcher, detailUrl, datasetReleaseId, sourcesDirectory) {
  const page = await fetcher.fetchDocument(detailUrl);
  const reference = readCongBaoDetailPage(Buffer.from(page.bytes).toString("utf8"));
  // The signed PDF is the legal artifact; the page is a record card for it.
  const pdf = await fetcher.fetchDocument(reference.pdfUrl);
  const storedName = await storeDocument(pdf, sourcesDirectory, reference.pdfUrl);
  const pdfText = await extractPdfLines(new Uint8Array(pdf.bytes));
  const { draft, report } = extractCongBaoDraft(pdfText, {
    datasetReleaseId,
    evidence: {
      locator: reference.locator,
      officialSourceUrl: pdf.officialSourceUrl,
      retrievedAt: pdf.retrievedAt,
      sourceSha256: pdf.sourceSha256,
    },
    reference,
  });
  const checks = crossCheckCongBao({
    draft,
    pdfText,
    reference,
    report,
    secondExtraction: secondExtractionOf(join(sourcesDirectory, storedName)),
  });
  return { checks, draft, pdf, reference, report, storedName };
}

// Raises every record that cleared all six checks to machine_checked, leaving
// the rest under_review. Returns the updated dataset text and the audit
// entries, so the caller decides where they are written.
function applyMachineChecks(datasetText, draft, checks) {
  let stagingText = datasetText;
  const audits = [];
  for (const version of draft.provisionVersions) {
    const provisionFlagged = checks.flaggedProvisionVersionIds.includes(version.provisionVersionId);
    try {
      const marked = markRecordMachineChecked({
        checks: {
          allPassed: checks.allPassed && !provisionFlagged,
          flagged: provisionFlagged ? [...checks.flagged, "NUMBERING"] : checks.flagged,
          notAvailable: checks.notAvailable,
        },
        datasetText: stagingText,
        provisionVersionId: version.provisionVersionId,
      });
      stagingText = marked.updatedDatasetText;
      audits.push(marked.audit);
    } catch (error) {
      if (!(error instanceof ReviewError) || error.code !== "CHECKS_NOT_PASSED") {
        throw error;
      }
    }
  }
  return { audits, stagingText };
}

// Failures that say something about the network or the moment, not about the
// document. These are retried on the next run rather than recorded as a
// decision.
const transientCodes = new Set([
  "FETCH_FAILED",
  "REQUEST_TIMEOUT",
  "RESPONSE_TOO_LARGE",
  "ROBOTS_FETCH_FAILED",
  "UNKNOWN",
]);

async function readJsonIfPresent(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
}

// Crawl a little, store a little, resume where it stopped. State records every
// detail URL already handled and, for a refusal, why - so a document the
// gazette leaves without an effective date is not re-fetched every run, and is
// still listed for a person to deal with.
async function runCongBaoBatch(flags) {
  const datasetReleaseId = flags.get("release");
  const stagingPath = flags.get("out");
  const seeds = flags.get("seeds");
  if (datasetReleaseId === undefined || stagingPath === undefined || seeds === undefined) {
    throw new Error(usage);
  }
  const max = Number(flags.get("max") ?? "10");
  const statePath = flags.get("state") ?? `${stagingPath}.batch-state.json`;
  const sourcesDirectory =
    flags.get("sources-dir") ?? join("data", "manual", "sources", "incoming");
  const fetcher = new DocumentFetcher(fetcherOptionsFrom(flags));

  const state = await readJsonIfPresent(statePath, { documents: {} });
  const seedUrls = seeds.split(",").map((seed) => seed.trim());
  const discovered = [];
  for (const seed of seedUrls) {
    // eslint-disable-next-line no-await-in-loop -- sequential fetching keeps the per-host rate limit honest
    const seedPage = await fetcher.fetchDocument(seed);
    const html = Buffer.from(seedPage.bytes).toString("utf8");
    for (const entry of discoverLinkEntries(html, seed, /\/van-ban\//u)) {
      if (!discovered.includes(entry.url)) {
        discovered.push(entry.url);
      }
    }
  }
  out(`phát hiện ${String(discovered.length)} trang chi tiết từ ${String(seedUrls.length)} seed`);

  const pending = discovered.filter((url) => state.documents[url] === undefined).slice(0, max);
  out(
    `${String(discovered.length - pending.length)} đã xử lý trước đó; lần này làm ${String(pending.length)}`,
  );

  const reviewPath = `${stagingPath}.needs-review.json`;
  const existingClean = await readJsonIfPresent(stagingPath, null);
  const existingReview = await readJsonIfPresent(reviewPath, null);
  const clean = existingClean === null ? [] : [...existingClean.provisionVersions];
  const needsReview = existingReview === null ? [] : [...existingReview.provisionVersions];
  let flaggedDocuments = 0;
  const audits = [];
  let ingested = 0;
  let refused = 0;
  let transient = 0;
  let machineChecked = 0;

  for (const url of pending) {
    let outcome;
    try {
      // eslint-disable-next-line no-await-in-loop -- one document at a time so the rate limit and the state file stay honest
      outcome = await ingestOneCongBaoDocument(fetcher, url, datasetReleaseId, sourcesDirectory);
    } catch (error) {
      const code = error?.code ?? "UNKNOWN";
      // A network hiccup is not a decision about the document. Recording it as
      // a refusal would retire the URL forever on a bad minute - which is
      // exactly what happened to Nghị định 327 the first time this ran, a
      // document that ingests cleanly on retry.
      if (transientCodes.has(code)) {
        transient += 1;
        out(`  TẠM LỖI ${code}  ${url} (sẽ thử lại lần sau)`);
        continue;
      }
      state.documents[url] = { at: new Date().toISOString(), reason: code, status: "refused" };
      refused += 1;
      out(`  TỪ CHỐI ${code}  ${url}`);
      continue;
    }
    const { checks, draft, reference } = outcome;
    // Each document is machine-checked on its own, then routed whole. A
    // document with one flagged article does not hold up the rest of the
    // batch: it goes to the needs-review file and a person deals with it
    // there, while the clean ones stay publishable. Routing whole documents
    // rather than loose articles matches how a reviewer actually reads.
    const applied = applyMachineChecks(`${JSON.stringify(draft, null, 2)}\n`, draft, checks);
    const marked = JSON.parse(applied.stagingText);
    const allClean = marked.provisionVersions.every(
      (version) => version.reviewStatus === "machine_checked",
    );
    if (allClean) {
      clean.push(...marked.provisionVersions);
      audits.push(...applied.audits);
      machineChecked += applied.audits.length;
      ingested += 1;
    } else {
      needsReview.push(...marked.provisionVersions);
      flaggedDocuments += 1;
    }
    state.documents[url] = {
      articles: draft.provisionVersions.length,
      at: new Date().toISOString(),
      documentNumber: reference.documentNumber,
      machineChecked: applied.audits.length,
      status: allClean ? "ingested" : "needs_review",
    };
    out(
      `  ${allClean ? "ĐÃ LẤY " : "CẦN XEM"} ${reference.documentNumber.padEnd(22)} ${String(draft.provisionVersions.length)} Điều, ${String(applied.audits.length)} lên machine_checked${checks.allPassed ? "" : ` (cờ: ${[...checks.flagged, ...checks.notAvailable].join(", ")})`}`,
    );
  }

  const fileFor = (versions) => ({
    amendments: [],
    applicability: [],
    datasetReleaseId,
    provisionVersions: versions,
    schemaVersion: 1,
  });
  if (clean.length > 0) {
    await writeFile(stagingPath, `${JSON.stringify(fileFor(clean), null, 2)}\n`, "utf8");
  }
  if (needsReview.length > 0) {
    await writeFile(reviewPath, `${JSON.stringify(fileFor(needsReview), null, 2)}\n`, "utf8");
  }
  if (audits.length > 0) {
    await appendReviewLog(stagingPath, audits);
  }
  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");

  out("");
  out(
    `lần này: ${String(ingested)} văn bản sạch, ${String(flaggedDocuments)} cần người xem, ${String(refused)} từ chối, ${String(transient)} tạm lỗi`,
  );
  out(`  publish được ngay : ${stagingPath} - ${String(clean.length)} Điều`);
  if (needsReview.length > 0) {
    out(`  chờ người xem     : ${reviewPath} - ${String(needsReview.length)} Điều`);
  }
  out(
    `  state             : ${statePath} - ${String(Object.keys(state.documents).length)} URL đã biết`,
  );
  out("Chạy lại lệnh này để lấy tiếp; đã lấy rồi thì không tải lại, tạm lỗi thì thử lại.");
}

async function runCongBao(detailUrl, flags) {
  const datasetReleaseId = flags.get("release");
  const stagingPath = flags.get("out");
  if (datasetReleaseId === undefined || stagingPath === undefined) {
    throw new Error(usage);
  }
  const sourcesDirectory =
    flags.get("sources-dir") ?? join("data", "manual", "sources", "incoming");
  const fetcher = new DocumentFetcher(fetcherOptionsFrom(flags));

  const page = await fetcher.fetchDocument(detailUrl);
  const reference = readCongBaoDetailPage(Buffer.from(page.bytes).toString("utf8"));
  out(`trang chi tiết: ${reference.documentNumber} - ${reference.locator}`);

  // The signed PDF is the legal artifact; the page is a record card for it.
  const pdf = await fetcher.fetchDocument(reference.pdfUrl);
  const storedName = await storeDocument(pdf, sourcesDirectory, reference.pdfUrl);
  const text = await extractPdfLines(new Uint8Array(pdf.bytes));
  const { draft, report } = extractCongBaoDraft(text, {
    datasetReleaseId,
    evidence: {
      locator: reference.locator,
      officialSourceUrl: pdf.officialSourceUrl,
      retrievedAt: pdf.retrievedAt,
      sourceSha256: pdf.sourceSha256,
    },
    reference,
  });

  // P-018: six cross-checks between the gazette page, the PDF body and our own
  // output. Records that pass every check become machine_checked; the rest stay
  // under_review for a person. The per-check results are written next to the
  // draft so the review queue can show exactly what disagreed.
  const checks = crossCheckCongBao({
    draft,
    pdfText: text,
    reference,
    report,
    secondExtraction: secondExtractionOf(join(sourcesDirectory, storedName)),
  });
  let stagingText = `${JSON.stringify(draft, null, 2)}\n`;
  const machineAudits = [];
  let machineChecked = 0;
  if (flags.get("no-machine-check") !== "true") {
    for (const version of draft.provisionVersions) {
      const provisionFlagged = checks.flaggedProvisionVersionIds.includes(
        version.provisionVersionId,
      );
      try {
        const marked = markRecordMachineChecked({
          checks: {
            allPassed: checks.allPassed && !provisionFlagged,
            flagged: provisionFlagged ? [...checks.flagged, "NUMBERING"] : checks.flagged,
            notAvailable: checks.notAvailable,
          },
          datasetText: stagingText,
          provisionVersionId: version.provisionVersionId,
        });
        stagingText = marked.updatedDatasetText;
        machineAudits.push(marked.audit);
        machineChecked += 1;
      } catch (error) {
        if (!(error instanceof ReviewError) || error.code !== "CHECKS_NOT_PASSED") {
          throw error;
        }
      }
    }
  }
  await writeFile(stagingPath, stagingText, "utf8");
  await writeFile(
    `${stagingPath}.checks.json`,
    `${JSON.stringify(
      {
        allPassed: checks.allPassed,
        documentNumber: reference.documentNumber,
        flagged: checks.flagged,
        flaggedProvisionVersionIds: checks.flaggedProvisionVersionIds,
        notAvailable: checks.notAvailable,
        results: checks.results,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  if (machineAudits.length > 0) {
    await appendReviewLog(stagingPath, machineAudits);
  }
  const characters = draft.provisionVersions.reduce(
    (total, version) => total + version.legalText.length,
    0,
  );
  out(
    [
      `draft: ${stagingPath}`,
      `  ${report.title}`,
      `  ${String(report.provisionCount)} Điều (${String(report.articleNumbers[0])}..${String(report.articleNumbers.at(-1))}), ${String(characters)} ký tự nguyên văn`,
      `  hiệu lực từ ${report.effectiveFrom}; mọi record ở trạng thái under_review`,
      `  PDF nguồn: ${storedName} (${pdf.sourceSha256})`,
      `  cỡ chữ thân bài ${String(report.bodyFontSize)}; bỏ ${String(report.runningLines.length)} dòng header lặp, giữ riêng ${String(report.apparatusLines.length)} dòng chú thích`,
    ].join("\n"),
  );
  out("  đối soát (P-018):");
  for (const result of checks.results) {
    const mark = result.status === "pass" ? "ĐẠT " : result.status === "flag" ? "CỜ  " : "CHƯA";
    out(`    ${mark} ${result.check.padEnd(18)} ${result.detail}`);
  }
  out(
    `  ${String(machineChecked)}/${String(draft.provisionVersions.length)} Điều lên machine_checked; ${String(draft.provisionVersions.length - machineChecked)} ở lại under_review cho người xem`,
  );
  if (report.closingBlockLines.length > 0) {
    // Shown, not silently removed: this text was in the document and a reviewer
    // must be able to see where it went.
    out(`  khối chữ ký (giữ ngoài nguyên văn Điều cuối): ${report.closingBlockLines.join(" / ")}`);
  }
  if (report.unassignedLines.length > 0) {
    // Reported rather than hidden: these are usually chapter titles and the
    // signature block, but a reviewer must be able to see what was not placed.
    out(
      `  ${String(report.unassignedLines.length)} dòng không thuộc Điều nào, cần người review xem:`,
    );
    for (const line of report.unassignedLines) {
      out(`    tr.${String(line.page)}: ${line.text}`);
    }
  }
}

async function runDrift(detailUrl, flags) {
  const dataDirectory = flags.get("data-dir") ?? join("data", "manual");
  const release = await loadPublishedRelease(dataDirectory);
  const documentId = `doc_vbpl_${vbplDocumentIdFromUrl(detailUrl)}`;
  const published = release.dataset.provisionVersions.filter(
    (provision) => provision.documentId === documentId,
  );
  if (published.length === 0) {
    fail(
      `DOCUMENT_NOT_IN_RELEASE: ${documentId} is not part of release ${release.datasetReleaseId}`,
    );
    return;
  }

  const fetcher = new DocumentFetcher(fetcherOptionsFrom(flags));
  const contentAction = flags.get("content-action");
  const payload =
    contentAction === undefined
      ? await fetchVbplContentFlight(fetcher, detailUrl)
      : await fetchVbplContentFlight(fetcher, detailUrl, contentAction);
  const { draft } = extractVbplDraft(Buffer.from(payload.bytes).toString("utf8"), {
    datasetReleaseId: release.datasetReleaseId,
    evidence: {
      officialSourceUrl: payload.officialSourceUrl,
      retrievedAt: payload.retrievedAt,
      sourceSha256: payload.sourceSha256,
    },
  });

  const issues = detectProvisionDrift(published, draft.provisionVersions);
  out(`drift check: ${documentId} in release ${release.datasetReleaseId}`);
  out(
    `  published provisions: ${published.length}, at source now: ${draft.provisionVersions.length}`,
  );
  if (issues.length === 0) {
    out("  no drift: published text still matches the source");
    return;
  }
  for (const issue of issues) {
    fail(`  ${issue.code} ${issue.locator}: ${issue.message}`);
  }
  fail("  the published release is immutable - review the changes and publish a new release");
}

async function runCrawl(flags) {
  const seeds = flags.get("seeds");
  const pattern = flags.get("pattern");
  const statePath = flags.get("state");
  const outputDirectory = flags.get("out");
  const max = flags.get("max");
  if (
    seeds === undefined ||
    pattern === undefined ||
    statePath === undefined ||
    outputDirectory === undefined ||
    max === undefined
  ) {
    throw new Error(usage);
  }

  // Git Bash on Windows rewrites an argument that looks like a Unix path, so
  // --pattern "/van-ban/" arrives as "C:/Program Files/Git/van-ban/". The crawl
  // then matches nothing and reports "0 fetched", which reads exactly like the
  // source blocking us. Refuse instead of crawling on a mangled pattern.
  if (/^[A-Za-z]:[\\/]/u.test(pattern)) {
    throw new Error(
      `--pattern looks like a Windows path ("${pattern}"), not a URL pattern. Git Bash rewrote it. ` +
        `Prefix the command with MSYS_NO_PATHCONV=1, or drop the leading slash (e.g. "van-ban/").`,
    );
  }

  let state = emptyIngestState();
  try {
    state = ingestStateSchema.parse(JSON.parse(await readFile(statePath, "utf8")));
  } catch {
    out(`state file ${statePath} missing or invalid; starting from an empty state`);
  }

  const fetcher = new DocumentFetcher(fetcherOptionsFrom(flags));
  const outcome = await crawlIncremental({
    detailPattern: new RegExp(pattern, "u"),
    fetcher,
    maxDocumentFetches: Number(max),
    seedUrls: seeds.split(",").map((seed) => seed.trim()),
    state,
  });

  for (const document of outcome.fetched) {
    // eslint-disable-next-line no-await-in-loop -- writes are small and ordered output is clearer
    const fileName = await storeDocument(document, outputDirectory, document.officialSourceUrl);
    out(`fetched ${document.officialSourceUrl} -> ${fileName}`);
  }
  await writeFile(statePath, `${JSON.stringify(outcome.state, null, 2)}\n`, "utf8");
  out(
    `crawl done: ${outcome.fetched.length} fetched, ${outcome.unchanged.length} unchanged, ` +
      `${outcome.skippedByLastModified.length} unchanged by lastmod, ` +
      `${outcome.skippedByBudget.length} skipped by budget; state saved to ${statePath}`,
  );
}

async function run() {
  const [command, ...rest] = process.argv.slice(2);
  const { flags, positional } = parseArguments(rest);
  switch (command) {
    case "fetch": {
      if (positional[0] === undefined) throw new Error(usage);
      await runFetch(positional[0], flags);
      return;
    }
    case "draft": {
      if (positional[0] === undefined) throw new Error(usage);
      await runDraft(positional[0], flags, flags.get("with-amendments") === "true");
      return;
    }
    case "drift": {
      if (positional[0] === undefined) throw new Error(usage);
      await runDrift(positional[0], flags);
      return;
    }
    case "crawl": {
      await runCrawl(flags);
      return;
    }
    case "congbao": {
      if (positional[0] === undefined) throw new Error(usage);
      await runCongBao(positional[0], flags);
      return;
    }
    case "congbao-batch": {
      await runCongBaoBatch(flags);
      return;
    }
    default: {
      throw new Error(usage);
    }
  }
}

run().catch((error) => {
  if (
    error instanceof IngestError ||
    error instanceof VbplExtractError ||
    error instanceof MergeDraftsError ||
    error instanceof CongBaoPageError ||
    error instanceof CongBaoExtractError ||
    error instanceof PdfTextError ||
    error instanceof ReviewError
  ) {
    fail(error.code === undefined ? error.message : `${error.code}: ${error.message}`);
    return;
  }
  fail(error instanceof Error ? error.message : "Unknown ingest CLI error");
});
