import { parseDatasetReleaseId } from "@luatvn/domain";
import { z } from "zod";

import { runDecoder, type DecodeResult } from "./decode.js";
import {
  domainValue,
  isoInstantSchema,
  maximumIdentifierLength,
  sha256Schema,
} from "./schema-primitives.js";

export const maximumManifestFiles = 256;

export const manifestPathSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[a-zA-Z0-9._/-]+$/u, "Manifest path contains unsupported characters")
  .refine(
    (value) => !value.startsWith("/") && !value.includes(".."),
    "Manifest path must be a safe relative path",
  );

const manifestFileSchema = z
  .object({
    path: manifestPathSchema,
    sha256: sha256Schema,
  })
  .strict();

// An archived source is addressed by its own SHA-256 and lives in one shared
// store that no release owns, so a document fetched once is stored once no
// matter how many releases cite it. A release records what it needs; it does
// not carry a private copy.
const manifestArchiveSchema = z
  .object({
    path: manifestPathSchema,
    sha256: sha256Schema,
  })
  .strict();

export const releaseManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    datasetReleaseId: domainValue(parseDatasetReleaseId, maximumIdentifierLength),
    releasedAt: isoInstantSchema,
    reviewedBy: z.string().min(1).max(256),
    reviewState: z.enum(["verified", "under_review", "unverified"]),
    files: z.array(manifestFileSchema).min(1).max(maximumManifestFiles),
    archives: z.array(manifestArchiveSchema).max(maximumManifestFiles).default([]),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const seenPaths = new Set<string>();
    manifest.files.forEach((file, index) => {
      if (seenPaths.has(file.path)) {
        ctx.addIssue({
          code: "custom",
          path: ["files", index, "path"],
          message: "Manifest file paths must be unique",
        });
      }
      seenPaths.add(file.path);
    });
    const seenArchives = new Set<string>();
    manifest.archives.forEach((archive, index) => {
      if (seenArchives.has(archive.sha256)) {
        ctx.addIssue({
          code: "custom",
          path: ["archives", index, "sha256"],
          message: "Manifest archive digests must be unique",
        });
      }
      seenArchives.add(archive.sha256);
    });
  });

export type ReleaseManifest = z.output<typeof releaseManifestSchema>;

export function decodeReleaseManifest(input: unknown): DecodeResult<ReleaseManifest> {
  return runDecoder(releaseManifestSchema, input);
}
