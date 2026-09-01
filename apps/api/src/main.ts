import { LegalQueryService } from "@luatvn/application";
import {
  loadPublishedRelease,
  ManualDatasetRepository,
  ReleaseStoreError,
} from "@luatvn/manual-dataset";
import { z } from "zod";

import { buildApi } from "./build-api.js";
import { readRuntimeConfig, RuntimeConfigError } from "./config.js";

function writeLogLine(payload: Readonly<Record<string, unknown>>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function writeErrorLine(payload: Readonly<Record<string, unknown>>): void {
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

async function main(): Promise<void> {
  const config = readRuntimeConfig(process.env);
  if (config.sourceHostAllowlist !== null) {
    writeLogLine({ event: "source_host_allowlist_active", hosts: config.sourceHostAllowlist });
  }
  const release = await loadPublishedRelease(
    config.dataDirectory,
    config.sourceHostAllowlist === null ? {} : { allowedHosts: config.sourceHostAllowlist },
  );
  const repository = new ManualDatasetRepository(release);
  const legalQueryService = new LegalQueryService(repository);
  const app = buildApi({ legalQueryService, operationTimeoutMs: config.operationTimeoutMs });

  app.get(
    "/ready",
    {
      schema: {
        response: {
          200: z.object({ datasetReleaseId: z.string(), status: z.literal("ready") }).strict(),
        },
      },
    },
    async () => ({ datasetReleaseId: release.datasetReleaseId, status: "ready" as const }),
  );

  let shutdownStarted = false;
  const shutdown = (reason: string): void => {
    if (shutdownStarted) {
      return;
    }
    shutdownStarted = true;
    writeLogLine({ event: "shutdown_started", reason });
    const forcedExit = setTimeout(() => {
      writeErrorLine({ event: "shutdown_forced", reason });
      process.exit(1);
    }, config.shutdownTimeoutMs);
    forcedExit.unref();
    void app.close().then(
      () => {
        writeLogLine({ event: "shutdown_complete", reason });
        process.exit(0);
      },
      () => {
        writeErrorLine({ event: "shutdown_failed", reason });
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
  if (process.send !== undefined) {
    process.on("message", (message) => {
      if (message === "shutdown") {
        shutdown("supervisor_message");
      }
    });
  }

  await app.listen({ host: config.host, port: config.port });
  const address = app.server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : config.port;
  writeLogLine({
    datasetReleaseId: release.datasetReleaseId,
    event: "listening",
    host: config.host,
    port: boundPort,
  });
  if (process.send !== undefined) {
    process.send({
      datasetReleaseId: release.datasetReleaseId,
      event: "listening",
      port: boundPort,
    });
  }
}

main().catch((error: unknown) => {
  if (error instanceof RuntimeConfigError) {
    writeErrorLine({
      code: "INVALID_RUNTIME_CONFIG",
      event: "startup_failed",
      issues: error.issues,
    });
  } else if (error instanceof ReleaseStoreError) {
    writeErrorLine({
      code: error.code,
      event: "startup_failed",
      issues: error.issues,
      message: error.message,
    });
  } else {
    writeErrorLine({
      code: "STARTUP_ERROR",
      event: "startup_failed",
      message: error instanceof Error ? error.message : "Unknown startup error",
    });
  }
  process.exit(1);
});
