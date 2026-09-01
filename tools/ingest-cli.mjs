import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import {
  crawlIncremental,
  DocumentFetcher,
  emptyIngestState,
  extractVbplDraft,
  extractVbplRelations,
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

fetch: store one document plus .evidence.json (URL, SHA-256, retrievedAt).
draft: fetch a vbpl.vn detail payload and extract an under_review staging draft
       for human review (docs/08-operator-runbook.md). --with-amendments also
       reads the relation graph, drafts each amended/replaced target document and
       links provision-level amendment drafts.
NOTE: original-document files ("Van ban goc"/"Tai ve") sit behind a CAPTCHA and
      are never fetched automatically - download those by hand.
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

const booleanFlags = new Set(["with-amendments"]);

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
    return { extracted, storedName };
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
  out(`next: pnpm dataset review ${stagingPath}`);
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
    case "crawl": {
      await runCrawl(flags);
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
    error instanceof MergeDraftsError
  ) {
    fail(error.code === undefined ? error.message : `${error.code}: ${error.message}`);
    return;
  }
  fail(error instanceof Error ? error.message : "Unknown ingest CLI error");
});
