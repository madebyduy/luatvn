import { createServer, type Server } from "node:http";

import {
  crawlIncremental,
  discoverLinks,
  DocumentFetcher,
  emptyIngestState,
  type IngestState,
} from "@luatvn/ingest";
import { afterAll, describe, expect, it } from "vitest";

interface CrawlFixture {
  readonly base: string;
  readonly bump: (path: string) => void;
  readonly close: () => Promise<void>;
  readonly requestCountFor: (path: string) => number;
}

const servers: Server[] = [];

async function startCrawlFixture(): Promise<CrawlFixture> {
  const versions = new Map<string, number>([
    ["/doc/a.html", 1],
    ["/doc/b.html", 1],
  ]);
  const requestCounts = new Map<string, number>();
  const server = createServer((request, response) => {
    const path = request.url ?? "/";
    requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);
    if (path === "/robots.txt") {
      response.statusCode = 404;
      response.end("no robots");
      return;
    }
    if (path === "/sitemap.xml") {
      response.setHeader("content-type", "application/xml");
      response.end(
        [
          "<urlset>",
          `<url><loc>/doc/a.html</loc><lastmod>v${String(versions.get("/doc/a.html"))}</lastmod></url>`,
          `<url><loc>/doc/b.html</loc><lastmod>v${String(versions.get("/doc/b.html"))}</lastmod></url>`,
          "</urlset>",
        ].join("\n"),
      );
      return;
    }
    if (path === "/list.html") {
      response.setHeader("content-type", "text/html");
      response.end(
        [
          '<a href="/doc/a.html">a</a>',
          '<a href="/doc/b.html">b</a>',
          '<a href="/doc/a.html#frag">a again</a>',
          '<a href="/other/c.html">not a detail page</a>',
          '<a href="https://elsewhere.invalid/doc/x.html">other host</a>',
        ].join("\n"),
      );
      return;
    }
    const version = versions.get(path);
    if (version !== undefined) {
      response.setHeader("content-type", "text/html");
      response.end(`<html><body>fixture document ${path} v${String(version)}</body></html>`);
      return;
    }
    response.statusCode = 404;
    response.end("missing");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Fixture server address unavailable");
  }
  return {
    base: `http://127.0.0.1:${String(address.port)}`,
    bump: (path) => {
      versions.set(path, (versions.get(path) ?? 0) + 1);
    },
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
    requestCountFor: (path) => requestCounts.get(path) ?? 0,
  };
}

afterAll(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
});

function crawlOptionsFor(fixture: CrawlFixture, state: IngestState, maxDocumentFetches = 10) {
  return {
    detailPattern: /\/doc\/[a-z]+\.html$/u,
    fetcher: new DocumentFetcher({ allowedHosts: ["127.0.0.1"], minIntervalMs: 0 }),
    maxDocumentFetches,
    seedUrls: [`${fixture.base}/list.html`],
    state,
  };
}

describe("discoverLinks", () => {
  it("extracts sitemap loc entries as well as anchors", () => {
    const sitemap = [
      "<urlset>",
      "<url><loc>https://vbpl.vn/doc/a.html</loc><lastmod>2026-08-31</lastmod></url>",
      "<url><loc> https://vbpl.vn/doc/b.html </loc></url>",
      "<url><loc>https://elsewhere.invalid/doc/c.html</loc></url>",
      "</urlset>",
    ].join("\n");
    const links = discoverLinks(sitemap, "https://vbpl.vn/sitemap/1.xml", /\/doc\/[a-z]+\.html$/u);
    expect(links.toSorted()).toEqual(["https://vbpl.vn/doc/a.html", "https://vbpl.vn/doc/b.html"]);
  });

  it("keeps only same-host links that match the detail pattern", () => {
    const html = [
      '<a href="/doc/a.html">a</a>',
      '<a href="/other/c.html">c</a>',
      '<a href="https://elsewhere.invalid/doc/x.html">x</a>',
      '<a href="/doc/a.html">duplicate</a>',
    ].join("");
    const links = discoverLinks(html, "https://vbpl.vn/list", /\/doc\/[a-z]+\.html$/u);
    expect(links).toEqual(["https://vbpl.vn/doc/a.html"]);
  });
});

describe("crawlIncremental", () => {
  it("fetches discovered detail pages and records their hashes", async () => {
    const fixture = await startCrawlFixture();
    const outcome = await crawlIncremental(crawlOptionsFor(fixture, emptyIngestState()));
    expect(outcome.fetched.map((document) => document.officialSourceUrl).toSorted()).toEqual([
      `${fixture.base}/doc/a.html`,
      `${fixture.base}/doc/b.html`,
    ]);
    expect(outcome.unchanged).toEqual([]);
    expect(Object.keys(outcome.state.documents)).toHaveLength(2);
  });

  it("re-fetches only changed documents on the next run", async () => {
    const fixture = await startCrawlFixture();
    const firstRun = await crawlIncremental(crawlOptionsFor(fixture, emptyIngestState()));

    const secondRun = await crawlIncremental(crawlOptionsFor(fixture, firstRun.state));
    expect(secondRun.fetched).toEqual([]);
    expect(secondRun.unchanged.toSorted()).toEqual([
      `${fixture.base}/doc/a.html`,
      `${fixture.base}/doc/b.html`,
    ]);

    fixture.bump("/doc/a.html");
    const thirdRun = await crawlIncremental(crawlOptionsFor(fixture, secondRun.state));
    expect(thirdRun.fetched.map((document) => document.officialSourceUrl)).toEqual([
      `${fixture.base}/doc/a.html`,
    ]);
    expect(thirdRun.unchanged).toEqual([`${fixture.base}/doc/b.html`]);
  });

  it("skips documents whose sitemap lastmod is unchanged without fetching them", async () => {
    const fixture = await startCrawlFixture();
    const sitemapOptions = (state: IngestState) => ({
      ...crawlOptionsFor(fixture, state),
      seedUrls: [`${fixture.base}/sitemap.xml`],
    });

    const firstRun = await crawlIncremental(sitemapOptions(emptyIngestState()));
    expect(firstRun.fetched).toHaveLength(2);
    const documentRequestsAfterFirstRun =
      fixture.requestCountFor("/doc/a.html") + fixture.requestCountFor("/doc/b.html");

    const secondRun = await crawlIncremental(sitemapOptions(firstRun.state));
    expect(secondRun.fetched).toEqual([]);
    expect(secondRun.skippedByLastModified.toSorted()).toEqual([
      `${fixture.base}/doc/a.html`,
      `${fixture.base}/doc/b.html`,
    ]);
    expect(fixture.requestCountFor("/doc/a.html") + fixture.requestCountFor("/doc/b.html")).toBe(
      documentRequestsAfterFirstRun,
    );

    fixture.bump("/doc/a.html");
    const thirdRun = await crawlIncremental(sitemapOptions(secondRun.state));
    expect(thirdRun.fetched.map((document) => document.officialSourceUrl)).toEqual([
      `${fixture.base}/doc/a.html`,
    ]);
    expect(thirdRun.skippedByLastModified).toEqual([`${fixture.base}/doc/b.html`]);
  });

  it("respects the per-run fetch budget", async () => {
    const fixture = await startCrawlFixture();
    const outcome = await crawlIncremental(crawlOptionsFor(fixture, emptyIngestState(), 1));
    expect(outcome.fetched).toHaveLength(1);
    expect(outcome.skippedByBudget).toHaveLength(1);
    expect(fixture.requestCountFor("/doc/a.html") + fixture.requestCountFor("/doc/b.html")).toBe(1);
  });
});
