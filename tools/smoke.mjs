// End-to-end smoke drill for the solo runtime (P-010 DATA-005).
// Publishes a clearly labeled operational drill release into an isolated
// temporary directory under tmp/, starts the real server process against it,
// exercises health/readiness/query/no-fallback behavior, then verifies
// graceful shutdown and that the release files were never mutated.
// Drill records contain placeholder text only and never touch data/manual.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { publishRelease } from "@luatvn/manual-dataset";

const failures = [];

function out(line) {
  process.stdout.write(`${line}\n`);
}

function check(name, condition, detail) {
  if (condition) {
    out(`ok   ${name}`);
  } else {
    failures.push(name);
    process.stderr.write(`FAIL ${name}${detail === undefined ? "" : `: ${detail}`}\n`);
  }
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

async function hashDirectory(directory) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .toSorted();
  const parts = await Promise.all(
    files.map(async (file) => `${file}:${sha256(await readFile(file, "utf8"))}`),
  );
  return parts.join("\n");
}

function drillDatasetText() {
  const legalText =
    "Smoke drill placeholder line one.\nOperational drill text only; this is not legal content.";
  const evidence = {
    evidenceId: "ev_smoke_drill",
    locator: null,
    officialSourceUrl: "https://smoke.invalid/drill-placeholder",
    retrievedAt: "2026-08-31T00:00:00.000Z",
    sourceSha256: sha256("smoke-drill-placeholder-source"),
  };
  return JSON.stringify(
    {
      schemaVersion: 1,
      datasetReleaseId: "rel_smoke_drill",
      provisionVersions: [
        {
          datasetReleaseId: "rel_smoke_drill",
          documentId: "doc_smoke_drill",
          documentNumber: "SMOKE-DRILL",
          evidence: [evidence],
          heading: null,
          legalText,
          legalTextSha256: sha256(legalText),
          primaryEvidenceId: "ev_smoke_drill",
          provisionId: "prov_smoke_drill",
          provisionVersionId: "pv_smoke_drill_v1",
          reviewStatus: "verified",
          systemTime: { from: "2026-08-31T00:00:00.000Z", to: null },
          validTime: { from: "2020-01-01", to: null },
        },
      ],
      amendments: [],
    },
    null,
    2,
  );
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  return { status: response.status, body: await response.json() };
}

async function run() {
  const dataDirectory = join("tmp", `smoke-${process.pid}`);
  await rm(dataDirectory, { recursive: true, force: true });
  await mkdir(dataDirectory, { recursive: true });

  const published = await publishRelease(dataDirectory, drillDatasetText(), {
    reviewedBy: "smoke-drill-operator",
    allowedHosts: ["smoke.invalid"],
  });
  out(`published drill release ${published.datasetReleaseId} in ${dataDirectory}`);
  const hashBefore = await hashDirectory(dataDirectory);

  const child = spawn(process.execPath, ["apps/api/dist/main.js"], {
    env: {
      ...process.env,
      LUATVN_DATA_DIR: dataDirectory,
      LUATVN_PORT: "0",
      LUATVN_SOURCE_HOST_ALLOWLIST: "smoke.invalid",
    },
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });

  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error("server did not report listening within 15s"));
    }, 15_000);
    child.on("message", (message) => {
      if (message !== null && typeof message === "object" && message.event === "listening") {
        clearTimeout(timer);
        resolve(message.port);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early with code ${code}`));
    });
  });
  out(`server listening on port ${port}`);

  const base = `http://127.0.0.1:${port}`;
  const knownAt = new Date().toISOString();
  const queryBody = (datasetReleaseId) => ({
    body: JSON.stringify({
      context: { datasetReleaseId, knownAt, requestId: "smoke-drill-request-1" },
      provisionId: "prov_smoke_drill",
      validAt: "2024-06-01",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

  const health = await fetchJson(`${base}/health`);
  check("GET /health returns ok", health.status === 200 && health.body.status === "ok");

  const ready = await fetchJson(`${base}/ready`);
  check(
    "GET /ready reports the published drill release",
    ready.status === 200 &&
      ready.body.status === "ready" &&
      ready.body.datasetReleaseId === "rel_smoke_drill",
  );

  const resolved = await fetchJson(`${base}/v1/provisions/at`, queryBody("rel_smoke_drill"));
  check(
    "POST /v1/provisions/at resolves the drill provision with citation",
    resolved.status === 200 &&
      resolved.body.data.status === "resolved" &&
      resolved.body.data.citation.provisionVersionId === "pv_smoke_drill_v1" &&
      resolved.body.untrustedContent === true,
    JSON.stringify(resolved.body),
  );

  const otherRelease = await fetchJson(`${base}/v1/provisions/at`, queryBody("rel_smoke_missing"));
  check(
    "unpublished release gets a stable unknown response with no fallback",
    otherRelease.status === 200 &&
      otherRelease.body.data.status === "unknown" &&
      otherRelease.body.data.reason === "NO_MATCHING_VERSION",
    JSON.stringify(otherRelease.body),
  );

  const badDate = await fetchJson(`${base}/v1/provisions/at`, {
    body: JSON.stringify({
      context: {
        datasetReleaseId: "rel_smoke_drill",
        knownAt,
        requestId: "smoke-drill-request-2",
      },
      provisionId: "prov_smoke_drill",
      validAt: "2024-02-30",
    }),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  check(
    "impossible calendar date is rejected with a stable public error",
    badDate.status === 400 && badDate.body.error.code === "INVALID_REQUEST",
    JSON.stringify(badDate.body),
  );

  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("server did not shut down within 10s"));
    }, 10_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve(code);
    });
    child.send("shutdown");
  });
  check("graceful shutdown exits with code 0", exitCode === 0, `exit code ${exitCode}`);

  let portClosed = false;
  try {
    await fetch(`${base}/health`);
  } catch {
    portClosed = true;
  }
  check("listener is closed after shutdown", portClosed);

  const hashAfter = await hashDirectory(dataDirectory);
  check("release files were not mutated by run/shutdown", hashBefore === hashAfter);

  await rm(dataDirectory, { recursive: true, force: true });

  if (failures.length > 0) {
    process.stderr.write(`SMOKE FAILED: ${failures.length} check(s) failed\n`);
    process.exitCode = 1;
  } else {
    out("SMOKE PASSED: install/publish/start/query/shutdown drill completed");
  }
}

run().catch((error) => {
  process.stderr.write(
    `SMOKE FAILED: ${error instanceof Error ? error.message : "unknown error"}\n`,
  );
  process.exitCode = 1;
});
