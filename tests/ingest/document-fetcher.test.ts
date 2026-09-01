import { createServer } from "node:http";

import { DocumentFetcher, IngestError } from "@luatvn/ingest";
import { sha256HexOfText } from "@luatvn/manual-dataset";
import { afterAll, describe, expect, it } from "vitest";

interface FixtureServer {
  readonly base: string;
  readonly requests: string[];
  readonly close: () => Promise<void>;
}

const fixtureBody = "fixture document body";

async function startFixtureServer(robotsText: string | null): Promise<FixtureServer> {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    requests.push(url);
    if (url === "/robots.txt") {
      if (robotsText === null) {
        response.statusCode = 404;
        response.end("not found");
        return;
      }
      response.setHeader("content-type", "text/plain");
      response.end(robotsText);
      return;
    }
    if (url === "/doc.txt" || url === "/private/open/doc.txt") {
      response.setHeader("content-type", "text/plain; charset=utf-8");
      response.end(fixtureBody);
      return;
    }
    if (url === "/big.bin") {
      response.end(Buffer.alloc(2_048));
      return;
    }
    if (url === "/error") {
      response.statusCode = 500;
      response.end("boom");
      return;
    }
    response.statusCode = 404;
    response.end("missing");
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("Fixture server address unavailable");
  }
  return {
    base: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
    requests,
  };
}

const openServers: FixtureServer[] = [];

async function serverWith(robotsText: string | null): Promise<FixtureServer> {
  const server = await startFixtureServer(robotsText);
  openServers.push(server);
  return server;
}

afterAll(async () => {
  await Promise.all(openServers.map((server) => server.close()));
});

const defaultRobots = ["User-agent: *", "Disallow: /private/", "Allow: /private/open"].join("\n");

function fetcherFor(overrides: ConstructorParameters<typeof DocumentFetcher>[0] = {}) {
  return new DocumentFetcher({ allowedHosts: ["127.0.0.1"], minIntervalMs: 0, ...overrides });
}

async function expectIngestError(
  work: Promise<unknown>,
  code: IngestError["code"],
): Promise<IngestError> {
  const outcome = await work.then(
    () => null,
    (error: unknown) => error,
  );
  expect(outcome).toBeInstanceOf(IngestError);
  if (!(outcome instanceof IngestError)) {
    throw new Error("Expected an IngestError");
  }
  expect(outcome.code).toBe(code);
  return outcome;
}

describe("DocumentFetcher", () => {
  it("fetches a document with full evidence fields", async () => {
    const server = await serverWith(defaultRobots);
    const document = await fetcherFor().fetchDocument(`${server.base}/doc.txt`);
    expect(document.byteLength).toBeGreaterThan(0);
    expect(document.sourceSha256).toBe(sha256HexOfText(fixtureBody));
    expect(document.contentType).toContain("text/plain");
    expect(document.officialSourceUrl).toBe(`${server.base}/doc.txt`);
    expect(new Date(document.retrievedAt).getTime()).not.toBeNaN();
  });

  it("refuses an unregistered host before touching the network", async () => {
    await expectIngestError(
      fetcherFor().fetchDocument("https://unregistered.invalid/doc.txt"),
      "HOST_NOT_REGISTERED",
    );
  });

  it("refuses plain http for a non-loopback host", async () => {
    await expectIngestError(
      fetcherFor({ allowedHosts: ["vbpl.vn"] }).fetchDocument("http://vbpl.vn/doc.txt"),
      "INSECURE_URL",
    );
  });

  it("obeys a robots.txt disallow rule", async () => {
    const server = await serverWith(defaultRobots);
    const fetcher = fetcherFor();
    await expectIngestError(
      fetcher.fetchDocument(`${server.base}/private/doc.txt`),
      "ROBOTS_DISALLOWED",
    );
    expect(server.requests).not.toContain("/private/doc.txt");
  });

  it("lets a longer allow rule override the disallow", async () => {
    const server = await serverWith(defaultRobots);
    const document = await fetcherFor().fetchDocument(`${server.base}/private/open/doc.txt`);
    expect(document.sourceSha256).toBe(sha256HexOfText(fixtureBody));
  });

  it("treats a missing robots.txt as allow-all", async () => {
    const server = await serverWith(null);
    const document = await fetcherFor().fetchDocument(`${server.base}/doc.txt`);
    expect(document.byteLength).toBeGreaterThan(0);
  });

  it("fails closed when robots.txt answers a server error", async () => {
    const errorServer = createServer((request, response) => {
      void request;
      response.statusCode = 503;
      response.end("unavailable");
    });
    await new Promise<void>((resolve) => {
      errorServer.listen(0, "127.0.0.1", resolve);
    });
    const address = errorServer.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("Error server address unavailable");
    }
    try {
      await expectIngestError(
        fetcherFor().fetchDocument(`http://127.0.0.1:${String(address.port)}/doc.txt`),
        "ROBOTS_UNAVAILABLE",
      );
    } finally {
      await new Promise<void>((resolve, reject) => {
        errorServer.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    }
  });

  it("rejects responses above the byte bound", async () => {
    const server = await serverWith(defaultRobots);
    await expectIngestError(
      fetcherFor({ maxBytes: 1_024 }).fetchDocument(`${server.base}/big.bin`),
      "RESPONSE_TOO_LARGE",
    );
  });

  it("maps upstream HTTP failures to a stable error", async () => {
    const server = await serverWith(defaultRobots);
    await expectIngestError(fetcherFor().fetchDocument(`${server.base}/error`), "HTTP_ERROR");
  });

  it("spaces same-host requests by the configured interval", async () => {
    const server = await serverWith(defaultRobots);
    const sleeps: number[] = [];
    const fetcher = fetcherFor({
      minIntervalMs: 1_000,
      now: () => 0,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });
    await fetcher.fetchDocument(`${server.base}/doc.txt`);
    await fetcher.fetchDocument(`${server.base}/doc.txt`);
    expect(sleeps).toEqual([1_000, 1_000]);
  });
});
