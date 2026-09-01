import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildApi } from "@luatvn/api";
import { LegalQueryService } from "@luatvn/application";
import { parseDatasetReleaseId } from "@luatvn/domain";
import {
  loadPublishedRelease,
  ManualDatasetRepository,
  publishRelease,
  sha256HexOfText,
} from "@luatvn/manual-dataset";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  syntheticAmendment,
  syntheticProvisionId,
  syntheticVersionOne,
  syntheticVersionTwo,
} from "../fixtures/synthetic-legal-data.js";

const runtimeReleaseId = parseDatasetReleaseId("rel_synthetic_runtime1");
const storeOptions = { allowedHosts: ["example.invalid"] } as const;

let dataDirectory = "";

beforeEach(async () => {
  dataDirectory = await mkdtemp(join(tmpdir(), "luatvn-runtime-"));
  const versions = [syntheticVersionOne, syntheticVersionTwo].map((version) =>
    Object.assign({}, version, {
      datasetReleaseId: runtimeReleaseId,
      legalTextSha256: sha256HexOfText(version.legalText),
    }),
  );
  await publishRelease(
    dataDirectory,
    JSON.stringify({
      schemaVersion: 1,
      datasetReleaseId: runtimeReleaseId,
      provisionVersions: versions,
      amendments: [syntheticAmendment],
    }),
    { reviewedBy: "synthetic reviewer", ...storeOptions },
  );
});

afterEach(async () => {
  await rm(dataDirectory, { force: true, recursive: true });
});

function queryPayload(datasetReleaseId: string): object {
  return {
    context: {
      datasetReleaseId,
      knownAt: "2026-08-31T12:00:00.000Z",
      requestId: "synthetic-runtime-request-1",
    },
    provisionId: syntheticProvisionId,
    validAt: "2024-06-01",
  };
}

async function apiFromPublishedRelease() {
  const release = await loadPublishedRelease(dataDirectory, storeOptions);
  const repository = new ManualDatasetRepository(release);
  return buildApi({ legalQueryService: new LegalQueryService(repository) });
}

describe("published release served through the REST boundary", () => {
  it("resolves a provision from the published release with full provenance", async () => {
    const app = await apiFromPublishedRelease();
    const response = await app.inject({
      method: "POST",
      payload: queryPayload(runtimeReleaseId),
      url: "/v1/provisions/at",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.status).toBe("resolved");
    expect(body.data.provision.provisionVersionId).toBe(
      String(syntheticVersionTwo.provisionVersionId),
    );
    expect(body.data.citation.datasetReleaseId).toBe(String(runtimeReleaseId));
    expect(body.untrustedContent).toBe(true);
  });

  it("answers unknown for an unpublished release instead of falling back", async () => {
    const app = await apiFromPublishedRelease();
    const response = await app.inject({
      method: "POST",
      payload: queryPayload("rel_synthetic_unpublished"),
      url: "/v1/provisions/at",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.status).toBe("unknown");
    expect(body.data.reason).toBe("NO_MATCHING_VERSION");
    expect(body.release.id).toBe("rel_synthetic_unpublished");
  });

  it("traces verified amendments from the published release", async () => {
    const app = await apiFromPublishedRelease();
    const response = await app.inject({
      method: "POST",
      payload: {
        context: {
          datasetReleaseId: runtimeReleaseId,
          knownAt: "2026-08-31T12:00:00.000Z",
          requestId: "synthetic-runtime-request-2",
        },
        maxDepth: 1,
        provisionId: syntheticProvisionId,
      },
      url: "/v1/provisions/amendments",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.status).toBe("resolved");
    expect(body.data.relations).toHaveLength(1);
    expect(body.data.relations[0].amendmentId).toBe(String(syntheticAmendment.amendmentId));
  });
});
