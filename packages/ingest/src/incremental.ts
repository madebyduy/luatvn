import { z } from "zod";

import type { DocumentFetcher, FetchedDocument } from "./fetcher.js";

const stateEntrySchema = z
  .object({
    lastCheckedAt: z.string().min(1).max(32),
    retrievedAt: z.string().min(1).max(32),
    sourceLastModified: z.string().max(64).nullable(),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const ingestStateSchema = z
  .object({
    documents: z.record(z.string().max(2_048), stateEntrySchema),
    schemaVersion: z.literal(1),
  })
  .strict();

export type IngestState = z.infer<typeof ingestStateSchema>;

export function emptyIngestState(): IngestState {
  return { documents: {}, schemaVersion: 1 };
}

export const maximumDiscoveredLinks = 1_000;
export const maximumSeeds = 16;

export interface DiscoveredLink {
  readonly url: string;
  // From the sitemap <lastmod> sibling when present; null for plain anchors.
  readonly lastModified: string | null;
}

// Understands both HTML anchors (href="...") and sitemap entries
// (<url><loc>...</loc><lastmod>...</lastmod></url>).
export function discoverLinkEntries(
  html: string,
  baseUrl: string,
  detailPattern: RegExp,
): readonly DiscoveredLink[] {
  const base = new URL(baseUrl);
  const entries = new Map<string, string | null>();
  const collect = (candidate: string, lastModified: string | null): void => {
    if (entries.size >= maximumDiscoveredLinks) {
      return;
    }
    try {
      const resolved = new URL(candidate, base);
      if (resolved.hostname === base.hostname && detailPattern.test(resolved.toString())) {
        const url = resolved.toString();
        entries.set(url, entries.get(url) ?? lastModified);
      }
    } catch {
      // Ignore unparsable link candidates.
    }
  };

  const hrefPattern = /href="([^"#]+)"/gu;
  let match = hrefPattern.exec(html);
  while (match !== null) {
    collect(match[1] ?? "", null);
    match = hrefPattern.exec(html);
  }
  const urlEntryPattern = /<loc>\s*([^<]+?)\s*<\/loc>(?:\s*<lastmod>\s*([^<]+?)\s*<\/lastmod>)?/gu;
  match = urlEntryPattern.exec(html);
  while (match !== null) {
    collect(match[1] ?? "", match[2] ?? null);
    match = urlEntryPattern.exec(html);
  }
  return [...entries.entries()].map(([url, lastModified]) => ({ lastModified, url }));
}

export function discoverLinks(
  html: string,
  baseUrl: string,
  detailPattern: RegExp,
): readonly string[] {
  return discoverLinkEntries(html, baseUrl, detailPattern).map((entry) => entry.url);
}

export interface CrawlOptions {
  readonly fetcher: DocumentFetcher;
  readonly seedUrls: readonly string[];
  readonly detailPattern: RegExp;
  readonly state: IngestState;
  readonly maxDocumentFetches: number;
}

export interface CrawlOutcome {
  readonly fetched: readonly FetchedDocument[];
  readonly unchanged: readonly string[];
  readonly skippedByLastModified: readonly string[];
  readonly skippedByBudget: readonly string[];
  readonly state: IngestState;
}

// Fetches seed pages, discovers same-host detail links and fetches each within
// the budget. Change detection prefers the sitemap lastmod (dynamic pages such
// as vbpl.vn embed per-request tokens, so their byte hash changes on every
// fetch); when a known lastmod is unchanged the document is skipped without a
// fetch. The SHA-256 comparison remains as a fallback for static sources.
export async function crawlIncremental(options: CrawlOptions): Promise<CrawlOutcome> {
  const seeds = options.seedUrls.slice(0, maximumSeeds);
  const discovered = new Map<string, string | null>();
  for (const seed of seeds) {
    // eslint-disable-next-line no-await-in-loop -- sequential fetching keeps the per-host rate limit honest
    const seedPage = await options.fetcher.fetchDocument(seed);
    const html = Buffer.from(seedPage.bytes).toString("utf8");
    for (const entry of discoverLinkEntries(html, seed, options.detailPattern)) {
      discovered.set(entry.url, discovered.get(entry.url) ?? entry.lastModified);
    }
  }

  const documents = { ...options.state.documents };
  const fetched: FetchedDocument[] = [];
  const unchanged: string[] = [];
  const skippedByLastModified: string[] = [];
  const skippedByBudget: string[] = [];
  let remainingBudget = options.maxDocumentFetches;

  for (const [url, lastModified] of discovered) {
    const prior = documents[url];
    if (prior !== undefined && lastModified !== null && prior.sourceLastModified === lastModified) {
      skippedByLastModified.push(url);
      continue;
    }
    if (remainingBudget <= 0) {
      skippedByBudget.push(url);
      continue;
    }
    remainingBudget -= 1;
    // eslint-disable-next-line no-await-in-loop -- sequential fetching keeps the per-host rate limit honest
    const document = await options.fetcher.fetchDocument(url);
    if (prior !== undefined && prior.sourceSha256 === document.sourceSha256) {
      unchanged.push(url);
      documents[url] = {
        ...prior,
        lastCheckedAt: document.retrievedAt,
        sourceLastModified: lastModified,
      };
      continue;
    }
    fetched.push(document);
    documents[url] = {
      lastCheckedAt: document.retrievedAt,
      retrievedAt: document.retrievedAt,
      sourceLastModified: lastModified,
      sourceSha256: document.sourceSha256,
    };
  }

  return {
    fetched,
    skippedByBudget,
    skippedByLastModified,
    state: { documents, schemaVersion: 1 },
    unchanged,
  };
}
