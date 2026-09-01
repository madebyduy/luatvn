import { LegalQueryService } from "@luatvn/application";
import {
  loadPublishedRelease,
  ManualDatasetRepository,
  ReleaseStoreError,
} from "@luatvn/manual-dataset";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { buildMcpServer } from "./server.js";

// stdout is the MCP transport, so every diagnostic goes to stderr.
function log(payload: Readonly<Record<string, unknown>>): void {
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

async function main(): Promise<void> {
  const dataDirectory = process.env["LUATVN_DATA_DIR"] ?? "data/manual";
  const allowlist = process.env["LUATVN_SOURCE_HOST_ALLOWLIST"];
  const loadOptions =
    allowlist === undefined
      ? {}
      : { allowedHosts: allowlist.split(",").map((host) => host.trim().toLowerCase()) };
  if (allowlist !== undefined) {
    log({ event: "source_host_allowlist_active", hosts: loadOptions.allowedHosts });
  }

  const release = await loadPublishedRelease(dataDirectory, loadOptions);
  const server = buildMcpServer({
    datasetReleaseId: release.datasetReleaseId,
    legalQueryService: new LegalQueryService(new ManualDatasetRepository(release)),
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log({ datasetReleaseId: release.datasetReleaseId, event: "mcp_ready", transport: "stdio" });

  const shutdown = (reason: string): void => {
    log({ event: "shutdown", reason });
    void server.close().then(
      () => {
        process.exit(0);
      },
      () => {
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => {
    shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    shutdown("SIGTERM");
  });
}

main().catch((error: unknown) => {
  if (error instanceof ReleaseStoreError) {
    log({
      code: error.code,
      event: "startup_failed",
      issues: error.issues,
      message: error.message,
    });
  } else {
    log({
      code: "STARTUP_ERROR",
      event: "startup_failed",
      message: error instanceof Error ? error.message : "Unknown startup error",
    });
  }
  process.exit(1);
});
