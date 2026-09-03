import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { parseIsoInstant, type DatasetReleaseId, type IsoInstant } from "@luatvn/domain";
import { z } from "zod";

import { decodeManualDatasetFile, type ManualDatasetFile } from "./dataset-schema.js";
import { decodeReleaseManifest, type ReleaseManifest } from "./release-manifest.js";
import type { ReviewAuditEntry } from "./review.js";
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
  | "REVIEW_LOG_INVALID"
  | "SOURCE_PATH_INVALID"
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
export const reviewLogFileName = "review-log.json";
// The published evidence store, shared by every release and content-addressed.
// Deliberately not "sources": that directory is the operator working area for
// raw downloads, which ADR-0005 keeps out of git. This one is evidence and
// travels with the releases that cite it.
export const sourceArchiveDirectory = "archive";
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

const reviewLogSchema = z.array(
  z
    .object({
      method: z.enum(["human", "machine"]).optional(),
      reviewedAt: z.string().min(1).max(32),
      reviewedBy: z.string().min(1).max(256),
      target: z.string().min(1).max(128),
    })
    .strict(),
);

export interface LoadedRelease {
  readonly datasetReleaseId: DatasetReleaseId;
  readonly dataset: ManualDatasetFile;
  readonly manifest: ReleaseManifest;
  // Every file the manifest lists, already checked against its recorded hash.
  // Present only when the caller asks for attachments; the runtime does not
  // need the archived sources in memory to answer queries.
  readonly files: ReadonlyMap<string, Uint8Array>;
  /**
   * Archives the manifest lists that have no local copy. Empty under the
   * "required" policy, because loading would have failed instead.
   */
  readonly missingArchives: readonly string[];
  readonly reviewLog: readonly ReviewAuditEntry[];
}

export interface ReleaseAttachment {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface PublishReleaseOptions {
  readonly reviewedBy: string;
  readonly now?: IsoInstant;
  readonly allowedHosts?: readonly string[];
  // Exact bytes of the sources the records were derived from. Archiving them
  // inside the release is what lets a third party re-derive the text instead of
  // taking the operator's word for it.
  readonly sources?: readonly ReleaseAttachment[];
  // Who promoted which record and when. Without this the release records a
  // single reviewer name and loses the per-record trail.
  readonly reviewLog?: readonly ReviewAuditEntry[];
}

export type ArchivePolicy = "required" | "optional";

export interface LoadReleaseOptions {
  /**
   * "required" (the default) keeps today's guarantee: a release that loads is a
   * release whose every archived source is present and intact. "optional" lets
   * a machine serve queries without carrying the archive - which is 52 times
   * heavier than the data queries actually need - and reports exactly which
   * archives are absent. Never silently: absent is recorded, and a present file
   * whose bytes do not match its digest still refuses to load, because that is
   * tampering rather than a missing copy.
   */
  readonly archivePolicy?: ArchivePolicy;
  readonly now?: IsoInstant;
  readonly allowedHosts?: readonly string[];
  // Manifest hashes are always checked; attachment bytes are only retained when
  // asked for, so a normal startup does not hold archived sources in memory.
  readonly includeAttachments?: boolean;
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

  // Files the release cannot be served without. Absent or altered means the
  // release does not load, under every policy.
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

  // Archived sources live in one store shared by every release. Answering a
  // query never reads them; only re-deriving the text from its source does.
  const archivePolicy = options.archivePolicy ?? "required";
  const archiveDirectory = join(dataDirectory, sourceArchiveDirectory);
  const missingArchives: string[] = [];
  const archiveEntries = await Promise.all(
    manifest.archives.map(async (archive) => {
      try {
        return { archive, bytes: await readFile(join(archiveDirectory, archive.path)) };
      } catch {
        return { archive, bytes: null };
      }
    }),
  );
  for (const { archive, bytes } of archiveEntries) {
    if (bytes === null) {
      if (archivePolicy === "required") {
        throw new ReleaseStoreError(
          "RELEASE_FILES_MISSING",
          `Release ${releaseId} has no local copy of archived source ${archive.path}; fetch it, or load with archivePolicy "optional" to serve queries without it`,
        );
      }
      missingArchives.push(archive.path);
      continue;
    }
    if (sha256HexOfBytes(bytes) !== archive.sha256) {
      // A wrong copy is not a missing copy. This one is refused under every
      // policy, because it means the bytes were altered after publication.
      throw new ReleaseStoreError(
        "RELEASE_FILE_HASH_MISMATCH",
        `Archived source ${archive.path} does not match its SHA-256; the archive was mutated`,
      );
    }
    bytesByPath.set(`${sourceArchiveDirectory}/${archive.path}`, bytes);
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

  let reviewLog: readonly ReviewAuditEntry[] = [];
  const reviewLogBytes = bytesByPath.get(reviewLogFileName);
  if (reviewLogBytes !== undefined) {
    let reviewLogJson: unknown;
    try {
      reviewLogJson = JSON.parse(stripByteOrderMark(Buffer.from(reviewLogBytes).toString("utf8")));
    } catch {
      throw new ReleaseStoreError(
        "REVIEW_LOG_INVALID",
        `Release ${releaseId} review log is not valid JSON`,
      );
    }
    const parsedLog = reviewLogSchema.safeParse(reviewLogJson);
    if (!parsedLog.success) {
      throw new ReleaseStoreError(
        "REVIEW_LOG_INVALID",
        `Release ${releaseId} review log does not match the audit schema`,
      );
    }
    reviewLog = parsedLog.data.map((entry) => ({
      reviewedAt: parseIsoInstant(entry.reviewedAt),
      reviewedBy: entry.reviewedBy,
      target: entry.target,
    }));
  }

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

  return {
    datasetReleaseId: dataset.datasetReleaseId,
    dataset,
    files: options.includeAttachments === true ? bytesByPath : new Map<string, Uint8Array>(),
    manifest,
    missingArchives,
    reviewLog,
  };
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

  const manifestFiles = [{ path: datasetFileName, sha256: sha256HexOfText(normalizedText) }];

  // Sources go to one store shared by every release, named by their own digest.
  // Publishing the same document again writes nothing: the bytes are already
  // there under the same name, and their hash proves it is the same document.
  const manifestArchives: { path: string; sha256: string }[] = [];
  const archiveDirectory = join(dataDirectory, sourceArchiveDirectory);
  for (const source of options.sources ?? []) {
    if (source.path.includes("/") || source.path.includes("..") || source.path.length === 0) {
      throw new ReleaseStoreError(
        "SOURCE_PATH_INVALID",
        `Archived source name "${source.path}" must be a plain file name`,
      );
    }
    const digest = sha256HexOfBytes(source.bytes);
    const dot = source.path.lastIndexOf(".");
    const extension = dot > 0 ? source.path.slice(dot) : "";
    const archiveName = `${digest}${extension}`;
    // eslint-disable-next-line no-await-in-loop -- one directory, created before the first write
    await mkdir(archiveDirectory, { recursive: true });
    // eslint-disable-next-line no-await-in-loop -- written in order so a failure leaves a partial store, not an interleaved one
    if (!(await pathExists(join(archiveDirectory, archiveName)))) {
      // eslint-disable-next-line no-await-in-loop -- see above
      await writeFile(join(archiveDirectory, archiveName), source.bytes);
    }
    if (!manifestArchives.some((entry) => entry.sha256 === digest)) {
      manifestArchives.push({ path: archiveName, sha256: digest });
    }
  }

  if (options.reviewLog !== undefined) {
    const reviewLogText = `${JSON.stringify(options.reviewLog, null, 2)}\n`;
    await writeFile(join(directory, reviewLogFileName), reviewLogText, "utf8");
    manifestFiles.push({ path: reviewLogFileName, sha256: sha256HexOfText(reviewLogText) });
  }

  const manifestCandidate = {
    schemaVersion: 1,
    datasetReleaseId: releaseId,
    releasedAt: now,
    reviewedBy,
    reviewState: "verified",
    files: manifestFiles,
    archives: manifestArchives,
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
