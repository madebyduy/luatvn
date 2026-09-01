import { parseIsoInstant, type IsoInstant } from "@luatvn/domain";
import { registeredSourceHosts, sha256HexOfBytes } from "@luatvn/manual-dataset";

import { isPathAllowed, parseRobots, type RobotsGroup } from "./robots.js";

export type IngestErrorCode =
  | "INVALID_URL"
  | "INSECURE_URL"
  | "HOST_NOT_REGISTERED"
  | "ROBOTS_UNAVAILABLE"
  | "ROBOTS_DISALLOWED"
  | "FETCH_FAILED"
  | "HTTP_ERROR"
  | "RESPONSE_TOO_LARGE";

export class IngestError extends Error {
  public constructor(
    public readonly code: IngestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IngestError";
  }
}

export interface FetchedDocument {
  readonly officialSourceUrl: string;
  readonly contentType: string | null;
  readonly byteLength: number;
  readonly bytes: Uint8Array;
  readonly sourceSha256: string;
  readonly retrievedAt: IsoInstant;
}

export interface DocumentFetcherOptions {
  readonly allowedHosts?: readonly string[];
  readonly userAgent?: string;
  readonly minIntervalMs?: number;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface FetchRequestInit {
  readonly method?: "GET" | "POST";
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}

const defaultUserAgent =
  "LuatVN-ingest/0.1 (registered official sources per docs/06-source-register.md SR-003)";

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function hostIsAllowed(hostname: string, allowedHosts: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

export class DocumentFetcher {
  private readonly allowedHosts: readonly string[];
  private readonly userAgent: string;
  private readonly minIntervalMs: number;
  private readonly maxBytes: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly robotsByOrigin = new Map<string, readonly RobotsGroup[]>();
  private readonly lastFetchAtByHost = new Map<string, number>();

  public constructor(options: DocumentFetcherOptions = {}) {
    this.allowedHosts = options.allowedHosts ?? registeredSourceHosts;
    this.userAgent = options.userAgent ?? defaultUserAgent;
    this.minIntervalMs = options.minIntervalMs ?? 2_000;
    this.maxBytes = options.maxBytes ?? 20 * 1_024 * 1_024;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
  }

  public async fetchDocument(url: string, init: FetchRequestInit = {}): Promise<FetchedDocument> {
    const parsed = this.assertFetchableUrl(url);

    const robots = await this.robotsFor(parsed.origin);
    const pathWithQuery = `${parsed.pathname}${parsed.search}`;
    if (!isPathAllowed(robots, this.userAgent, pathWithQuery)) {
      throw new IngestError(
        "ROBOTS_DISALLOWED",
        `robots.txt of ${parsed.origin} disallows ${parsed.pathname}`,
      );
    }

    await this.respectRateLimit(parsed.hostname);
    const response = await this.request(parsed.toString(), init);
    if (response.url !== "" && response.url !== parsed.toString()) {
      this.assertFetchableUrl(response.url);
    }
    if (!response.ok) {
      throw new IngestError("HTTP_ERROR", `${parsed.origin} answered HTTP ${response.status}`);
    }
    const declaredLength = Number(response.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > this.maxBytes) {
      throw new IngestError(
        "RESPONSE_TOO_LARGE",
        `Declared content length exceeds the ${this.maxBytes}-byte bound`,
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > this.maxBytes) {
      throw new IngestError(
        "RESPONSE_TOO_LARGE",
        `Response exceeds the ${this.maxBytes}-byte bound`,
      );
    }

    return {
      byteLength: bytes.byteLength,
      bytes,
      contentType: response.headers.get("content-type"),
      officialSourceUrl: parsed.toString(),
      retrievedAt: parseIsoInstant(new Date().toISOString()),
      sourceSha256: sha256HexOfBytes(bytes),
    };
  }

  private assertFetchableUrl(url: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new IngestError("INVALID_URL", "URL could not be parsed");
    }
    const insecureLoopback = parsed.protocol === "http:" && isLoopback(parsed.hostname);
    if (parsed.protocol !== "https:" && !insecureLoopback) {
      throw new IngestError(
        "INSECURE_URL",
        "Only https URLs are fetched (http is allowed for loopback tests only)",
      );
    }
    if (!hostIsAllowed(parsed.hostname, this.allowedHosts)) {
      throw new IngestError(
        "HOST_NOT_REGISTERED",
        `Host ${parsed.hostname} is not a registered source (docs/06-source-register.md)`,
      );
    }
    return parsed;
  }

  private async request(url: string, init: FetchRequestInit = {}): Promise<Response> {
    try {
      return await fetch(url, {
        ...(init.body === undefined ? {} : { body: init.body }),
        headers: { ...init.headers, "user-agent": this.userAgent },
        method: init.method ?? "GET",
        redirect: "follow",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new IngestError(
        "FETCH_FAILED",
        error instanceof Error ? error.message : "Network request failed",
      );
    }
  }

  private async respectRateLimit(hostname: string): Promise<void> {
    const last = this.lastFetchAtByHost.get(hostname);
    if (last !== undefined) {
      const waitMs = this.minIntervalMs - (this.now() - last);
      if (waitMs > 0) {
        await this.sleep(waitMs);
      }
    }
    this.lastFetchAtByHost.set(hostname, this.now());
  }

  private async robotsFor(origin: string): Promise<readonly RobotsGroup[]> {
    const cached = this.robotsByOrigin.get(origin);
    if (cached !== undefined) {
      return cached;
    }

    await this.respectRateLimit(new URL(origin).hostname);
    let response: Response;
    try {
      response = await this.request(`${origin}/robots.txt`);
    } catch {
      throw new IngestError(
        "ROBOTS_UNAVAILABLE",
        `robots.txt of ${origin} could not be fetched; failing closed`,
      );
    }

    let groups: readonly RobotsGroup[];
    if (response.status === 404) {
      groups = [];
    } else if (response.ok) {
      groups = parseRobots(await response.text());
    } else {
      throw new IngestError(
        "ROBOTS_UNAVAILABLE",
        `robots.txt of ${origin} answered HTTP ${response.status}; failing closed`,
      );
    }
    this.robotsByOrigin.set(origin, groups);
    return groups;
  }
}
