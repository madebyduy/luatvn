import { z } from "zod";

import { runDecoder, type DecodeResult } from "./decode.js";
import { manifestPathSchema } from "./release-manifest.js";
import { isoInstantSchema, sha256Schema } from "./schema-primitives.js";

export const maximumSourceFiles = 200_000;

const sourceFileSchema = z
  .object({
    byteLength: z.number().int().nonnegative(),
    path: manifestPathSchema,
    sha256: sha256Schema,
  })
  .strict();

export type SourceFileEntry = z.infer<typeof sourceFileSchema>;

export const sourceStoreManifestSchema = z
  .object({
    files: z.array(sourceFileSchema).max(maximumSourceFiles),
    generatedAt: isoInstantSchema,
    schemaVersion: z.literal(1),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const seen = new Set<string>();
    manifest.files.forEach((file, index) => {
      if (seen.has(file.path)) {
        ctx.addIssue({
          code: "custom",
          message: "Source manifest paths must be unique",
          path: ["files", index, "path"],
        });
      }
      seen.add(file.path);
    });
  });

export type SourceStoreManifest = z.output<typeof sourceStoreManifestSchema>;

export function decodeSourceStoreManifest(input: unknown): DecodeResult<SourceStoreManifest> {
  return runDecoder(sourceStoreManifestSchema, input);
}

// Source files live on the operator's disk and are never committed (ADR-0005),
// so the manifest is the only thing git can check a backup against.
export function buildSourceStoreManifest(
  files: readonly SourceFileEntry[],
  generatedAt: string,
): DecodeResult<SourceStoreManifest> {
  const ordered = files.toSorted((left, right) => left.path.localeCompare(right.path));
  return decodeSourceStoreManifest({ files: ordered, generatedAt, schemaVersion: 1 });
}

export type SourceVerificationCode = "MISSING" | "HASH_MISMATCH" | "SIZE_MISMATCH" | "UNREGISTERED";

export interface SourceVerificationIssue {
  readonly code: SourceVerificationCode;
  readonly path: string;
  readonly message: string;
}

export function verifySourceStoreManifest(
  manifest: SourceStoreManifest,
  actualFiles: readonly SourceFileEntry[],
): readonly SourceVerificationIssue[] {
  const actualByPath = new Map(actualFiles.map((file) => [file.path, file]));
  const issues: SourceVerificationIssue[] = [];

  for (const expected of manifest.files) {
    const actual = actualByPath.get(expected.path);
    if (actual === undefined) {
      issues.push({
        code: "MISSING",
        message: "File listed in the manifest is not on disk",
        path: expected.path,
      });
      continue;
    }
    if (actual.sha256 !== expected.sha256) {
      issues.push({
        code: "HASH_MISMATCH",
        message: "File content differs from the manifest SHA-256",
        path: expected.path,
      });
    } else if (actual.byteLength !== expected.byteLength) {
      issues.push({
        code: "SIZE_MISMATCH",
        message: "File size differs from the manifest entry",
        path: expected.path,
      });
    }
  }

  const registered = new Set(manifest.files.map((file) => file.path));
  for (const actual of actualFiles) {
    if (!registered.has(actual.path)) {
      issues.push({
        code: "UNREGISTERED",
        message: "File on disk is not listed in the manifest",
        path: actual.path,
      });
    }
  }

  return issues;
}
