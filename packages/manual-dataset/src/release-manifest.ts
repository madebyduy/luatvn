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

export const releaseManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    datasetReleaseId: domainValue(parseDatasetReleaseId, maximumIdentifierLength),
    releasedAt: isoInstantSchema,
    reviewedBy: z.string().min(1).max(256),
    reviewState: z.enum(["verified", "under_review", "unverified"]),
    files: z.array(manifestFileSchema).min(1).max(maximumManifestFiles),
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
  });

export type ReleaseManifest = z.output<typeof releaseManifestSchema>;

export function decodeReleaseManifest(input: unknown): DecodeResult<ReleaseManifest> {
  return runDecoder(releaseManifestSchema, input);
}
