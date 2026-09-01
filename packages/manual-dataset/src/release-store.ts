import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseIsoInstant, type DatasetReleaseId, type IsoInstant } from "@luatvn/domain";
import { z } from "zod";

import { decodeManualDatasetFile, type ManualDatasetFile } from "./dataset-schema.js";
import { decodeReleaseManifest, type ReleaseManifest } from "./release-manifest.js";
import {
  sha256HexOfBytes,
  sha256HexOfText,
  validateReleaseForPublish,
  type ReleaseValidationIssue,
} from "./validate-release.js";

export type ReleaseStoreErrorCode =
  | "REVIEWER_REQUIRED"
  | "DATASET_PARSE_FAILED"
  | "DATASET_INVALID"
  | "RELEASE_VALIDATION_FAILED"
  | "RELEASE_ALREADY_EXISTS"
  | "POINTER_MISSING"
  | "POINTER_INVALID"
  | "MANIFEST_INVALID"
  | "MANIFEST_MISMATCH"
  | "RELEASE_NOT_REVIEWED"
  | "RELEASE_FILES_MISSING"
  | "RELEASE_FILE_HASH_MISMATCH"
  | "ROLLBACK_UNAVAILABLE";

export class ReleaseStoreError extends Error {
  public constructor(
    public readonly code: ReleaseStoreErrorCode,
    message: string,
    public readonly issues: readonly ReleaseValidationIssue[] = [],
  ) {
    super(message);
    this.name = "ReleaseStoreError";
  }
}

const datasetFileName = "dataset.json";
const manifestFileName = "manifest.json";
const maximumPointerHistory = 32;

const publishedPointerSchema = z
  .object({
    schemaVersion: z.literal(1),
    currentReleaseId: z.string().min(1).max(128),
    previousReleaseIds: z.array(z.string().min(1).max(128)).max(maximumPointerHistory),
    updatedAt: z.string().min(1).max(32),
  })
  .strict();

export type PublishedPointer = z.infer<typeof publishedPointerSchema>;

export interface LoadedRelease {
  readonly datasetReleaseId: DatasetReleaseId;
  readonly dataset: ManualDatasetFile;
  readonly manifest: ReleaseManifest;
}

export interface PublishReleaseOptions {
  readonly reviewedBy: string;
  readonly now?: IsoInstant;
  readonly allowedHosts?: readonly string[];
}

export interface LoadReleaseOptions {
  readonly now?: IsoInstant;
  readonly allowedHosts?: readonly string[];
}

function pointerPath(dataDirectory: string): string {
  return join(dataDirectory, "published.json");
}

function releaseDirectory(dataDirectory: string, releaseId: string): string {
  return join(dataDirectory, "releases", releaseId);
}

function nowInstant(): IsoInstant {
  return parseIsoInstant(new Date().toISOString());
}

// Windows editors often prepend a UTF-8 byte order mark (U+FEFF) that JSON.parse rejects.
export function stripByteOrderMark(text: string): string {
  return text.charCodeAt(0) === 0xfe_ff ? text.slice(1) : text;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeFileAtomic(path: string, text: string): Promise<void> {
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, text, "utf8");
  await rename(temporaryPath, path);
}

async function readPointerIfPresent(dataDirectory: string): Promise<PublishedPointer | null> {
  let text: string;
  try {
    text = await readFile(pointerPath(dataDirectory), "utf8");
  } catch {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch {
    throw new ReleaseStoreError("POINTER_INVALID", "published.json is not valid JSON");
  }
  const parsed = publishedPointerSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new ReleaseStoreError(
      "POINTER_INVALID",
      "published.json does not match the pointer schema",
    );
  }
  return parsed.data;
}

export async function getPublishedPointer(dataDirectory: string): Promise<PublishedPointer> {
  const pointer = await readPointerIfPresent(dataDirectory);
  if (pointer === null) {
    throw new ReleaseStoreError(
      "POINTER_MISSING",
      "No published release pointer exists; publish a reviewed release first",
    );
  }
  return pointer;
}

async function writePointer(dataDirectory: string, pointer: PublishedPointer): Promise<void> {
  await writeFileAtomic(pointerPath(dataDirectory), `${JSON.stringify(pointer, null, 2)}\n`);
}

function decodeIssuesToValidationIssues(
  issues: readonly { readonly path: string; readonly message: string }[],
): readonly ReleaseValidationIssue[] {
  return issues.map((issue) => ({ locator: issue.path, message: issue.message }));
}

async function loadReleaseById(
  dataDirectory: string,
  releaseId: string,
  options: LoadReleaseOptions,
): Promise<LoadedRelease> {
  const directory = releaseDirectory(dataDirectory, releaseId);

  let manifestText: string;
  try {
    manifestText = await readFile(join(directory, manifestFileName), "utf8");
  } catch {
    throw new ReleaseStoreError(
      "RELEASE_FILES_MISSING",
      `Release ${releaseId} has no readable ${manifestFileName}`,
    );
  }
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestText);
  } catch {
    throw new ReleaseStoreError(
      "MANIFEST_INVALID",
      `Release ${releaseId} manifest is not valid JSON`,
    );
  }
  const manifestResult = decodeReleaseManifest(manifestJson);
  if (!manifestResult.ok) {
    throw new ReleaseStoreError(
      "MANIFEST_INVALID",
      `Release ${releaseId} manifest does not match the manifest schema`,
      decodeIssuesToValidationIssues(manifestResult.issues),
    );
  }
  const manifest = manifestResult.value;

  if (manifest.datasetReleaseId !== releaseId) {
    throw new ReleaseStoreError(
      "MANIFEST_MISMATCH",
      `Manifest release ${manifest.datasetReleaseId} does not match requested release ${releaseId}`,
    );
  }
  if (manifest.reviewState !== "verified") {
    throw new ReleaseStoreError(
      "RELEASE_NOT_REVIEWED",
      `Release ${releaseId} manifest review state is ${manifest.reviewState}; only verified releases may load`,
    );
  }

  const fileEntries = await Promise.all(
    manifest.files.map(async (file) => {
      try {
        return { bytes: await readFile(join(directory, file.path)), file };
      } catch {
        throw new ReleaseStoreError(
          "RELEASE_FILES_MISSING",
          `Release ${releaseId} is missing manifest file ${file.path}`,
        );
      }
    }),
  );
  const bytesByPath = new Map<string, Uint8Array>();
  for (const { bytes, file } of fileEntries) {
    if (sha256HexOfBytes(bytes) !== file.sha256) {
      throw new ReleaseStoreError(
        "RELEASE_FILE_HASH_MISMATCH",
        `Release ${releaseId} file ${file.path} does not match its manifest SHA-256; the release was mutated`,
      );
    }
    bytesByPath.set(file.path, bytes);
  }

  const datasetBytes = bytesByPath.get(datasetFileName);
  if (datasetBytes === undefined) {
    throw new ReleaseStoreError(
      "MANIFEST_INVALID",
      `Release ${releaseId} manifest does not list ${datasetFileName}`,
    );
  }

  let datasetJson: unknown;
  try {
    datasetJson = JSON.parse(stripByteOrderMark(Buffer.from(datasetBytes).toString("utf8")));
  } catch {
    throw new ReleaseStoreError(
      "DATASET_PARSE_FAILED",
      `Release ${releaseId} dataset is not valid JSON`,
    );
  }
  const datasetResult = decodeManualDatasetFile(datasetJson);
  if (!datasetResult.ok) {
    throw new ReleaseStoreError(
      "DATASET_INVALID",
      `Release ${releaseId} dataset does not match the dataset schema`,
      decodeIssuesToValidationIssues(datasetResult.issues),
    );
  }
  const dataset = datasetResult.value;

  if (dataset.datasetReleaseId !== manifest.datasetReleaseId) {
    throw new ReleaseStoreError(
      "MANIFEST_MISMATCH",
      `Dataset release ${dataset.datasetReleaseId} does not match manifest release ${manifest.datasetReleaseId}`,
    );
  }

  const validationIssues = validateReleaseForPublish(dataset, {
    now: options.now ?? nowInstant(),
    ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
  });
  if (validationIssues.length > 0) {
    throw new ReleaseStoreError(
      "RELEASE_VALIDATION_FAILED",
      `Release ${releaseId} failed provenance validation`,
      validationIssues,
    );
  }

  return { datasetReleaseId: dataset.datasetReleaseId, dataset, manifest };
}

export async function publishRelease(
  dataDirectory: string,
  datasetText: string,
  options: PublishReleaseOptions,
): Promise<{ readonly datasetReleaseId: DatasetReleaseId }> {
  const reviewedBy = options.reviewedBy.trim();
  if (reviewedBy.length === 0) {
    throw new ReleaseStoreError(
      "REVIEWER_REQUIRED",
      "publish requires the name of the human reviewer who verified this dataset",
    );
  }

  const normalizedText = stripByteOrderMark(datasetText);
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(normalizedText);
  } catch {
    throw new ReleaseStoreError("DATASET_PARSE_FAILED", "Dataset file is not valid JSON");
  }
  const decoded = decodeManualDatasetFile(parsedJson);
  if (!decoded.ok) {
    throw new ReleaseStoreError(
      "DATASET_INVALID",
      "Dataset file does not match the dataset schema",
      decodeIssuesToValidationIssues(decoded.issues),
    );
  }

  const now = options.now ?? nowInstant();
  const validationIssues = validateReleaseForPublish(decoded.value, {
    now,
    ...(options.allowedHosts === undefined ? {} : { allowedHosts: options.allowedHosts }),
  });
  if (validationIssues.length > 0) {
    throw new ReleaseStoreError(
      "RELEASE_VALIDATION_FAILED",
      "Dataset failed provenance validation and was not published",
      validationIssues,
    );
  }

  const existingPointer = await readPointerIfPresent(dataDirectory);

  const releaseId = decoded.value.datasetReleaseId;
  const directory = releaseDirectory(dataDirectory, releaseId);
  if (await pathExists(directory)) {
    throw new ReleaseStoreError(
      "RELEASE_ALREADY_EXISTS",
      `Release ${releaseId} already exists and is immutable; publish under a new release ID`,
    );
  }
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, datasetFileName), normalizedText, "utf8");

  const manifestCandidate = {
    schemaVersion: 1,
    datasetReleaseId: releaseId,
    releasedAt: now,
    reviewedBy,
    reviewState: "verified",
    files: [{ path: datasetFileName, sha256: sha256HexOfText(normalizedText) }],
  };
  const manifestResult = decodeReleaseManifest(manifestCandidate);
  if (!manifestResult.ok) {
    throw new ReleaseStoreError(
      "MANIFEST_INVALID",
      "Generated manifest does not match the manifest schema",
      decodeIssuesToValidationIssues(manifestResult.issues),
    );
  }
  await writeFile(
    join(directory, manifestFileName),
    `${JSON.stringify(manifestCandidate, null, 2)}\n`,
    "utf8",
  );

  const previousReleaseIds =
    existingPointer === null
      ? []
      : [existingPointer.currentReleaseId, ...existingPointer.previousReleaseIds].slice(
          0,
          maximumPointerHistory,
        );
  await writePointer(dataDirectory, {
    schemaVersion: 1,
    currentReleaseId: releaseId,
    previousReleaseIds,
    updatedAt: now,
  });

  return { datasetReleaseId: releaseId };
}

export async function loadPublishedRelease(
  dataDirectory: string,
  options: LoadReleaseOptions = {},
): Promise<LoadedRelease> {
  const pointer = await getPublishedPointer(dataDirectory);
  return loadReleaseById(dataDirectory, pointer.currentReleaseId, options);
}

export async function rollbackPublishedRelease(
  dataDirectory: string,
  options: LoadReleaseOptions = {},
): Promise<{ readonly restoredReleaseId: DatasetReleaseId }> {
  const pointer = await getPublishedPointer(dataDirectory);
  const [previousReleaseId, ...olderReleaseIds] = pointer.previousReleaseIds;
  if (previousReleaseId === undefined) {
    throw new ReleaseStoreError(
      "ROLLBACK_UNAVAILABLE",
      "No previous published release exists to roll back to",
    );
  }

  const restored = await loadReleaseById(dataDirectory, previousReleaseId, options);
  await writePointer(dataDirectory, {
    schemaVersion: 1,
    currentReleaseId: previousReleaseId,
    previousReleaseIds: olderReleaseIds,
    updatedAt: options.now ?? nowInstant(),
  });

  return { restoredReleaseId: restored.datasetReleaseId };
}
