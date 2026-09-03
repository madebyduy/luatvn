import {
  assertValidInterval,
  parseAmendmentId,
  parseDatasetReleaseId,
  parseDocumentId,
  parseEvidenceId,
  parseProvisionId,
  parseProvisionVersionId,
  type AmendmentRelation,
  type EvidenceReference,
  type PublishedProvisionVersion,
} from "@luatvn/domain";
import { z } from "zod";

import { runDecoder, type DecodeResult } from "./decode.js";
import {
  domainValue,
  isoInstantSchema,
  issueMessageFrom,
  legalDateSchema,
  maximumIdentifierLength,
  officialSourceUrlSchema,
  sha256Schema,
} from "./schema-primitives.js";

export const maximumEvidencePerRecord = 16;
export const maximumLegalTextLength = 200_000;
export const maximumProvisionVersionRecords = 10_000;
export const maximumAmendmentRecords = 10_000;

const reviewStatusSchema = z.enum(["verified", "machine_checked", "under_review", "unverified"]);

const evidenceReferenceSchema = z
  .object({
    evidenceId: domainValue(parseEvidenceId, maximumIdentifierLength),
    locator: z.string().min(1).max(512).nullable(),
    officialSourceUrl: officialSourceUrlSchema,
    retrievedAt: isoInstantSchema,
    sourceSha256: sha256Schema,
  })
  .strict();

const validTimeSchema = z
  .object({
    from: legalDateSchema,
    to: legalDateSchema.nullable(),
  })
  .strict()
  .superRefine((interval, ctx) => {
    try {
      assertValidInterval(interval, "validTime");
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: issueMessageFrom(error, "validTime interval is invalid"),
      });
    }
  });

const systemTimeSchema = z
  .object({
    from: isoInstantSchema,
    to: isoInstantSchema.nullable(),
  })
  .strict()
  .superRefine((interval, ctx) => {
    try {
      assertValidInterval(interval, "systemTime");
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        message: issueMessageFrom(error, "systemTime interval is invalid"),
      });
    }
  });

function toNonEmptyEvidence(
  items: readonly EvidenceReference[],
): readonly [EvidenceReference, ...EvidenceReference[]] {
  const [first, ...rest] = items;
  if (first === undefined) {
    throw new Error("Evidence list invariant failed after schema validation");
  }
  return [first, ...rest];
}

export const provisionVersionRecordSchema = z
  .object({
    datasetReleaseId: domainValue(parseDatasetReleaseId, maximumIdentifierLength),
    documentId: domainValue(parseDocumentId, maximumIdentifierLength),
    documentNumber: z.string().min(1).max(256),
    evidence: z.array(evidenceReferenceSchema).min(1).max(maximumEvidencePerRecord),
    heading: z.string().min(1).max(1_024).nullable(),
    legalText: z.string().min(1).max(maximumLegalTextLength),
    legalTextSha256: sha256Schema,
    primaryEvidenceId: domainValue(parseEvidenceId, maximumIdentifierLength),
    provisionId: domainValue(parseProvisionId, maximumIdentifierLength),
    provisionVersionId: domainValue(parseProvisionVersionId, maximumIdentifierLength),
    reviewStatus: reviewStatusSchema,
    systemTime: systemTimeSchema,
    validTime: validTimeSchema,
  })
  .strict()
  .superRefine((record, ctx) => {
    const matches = record.evidence.filter(
      (evidence) => evidence.evidenceId === record.primaryEvidenceId,
    );
    if (matches.length !== 1) {
      ctx.addIssue({
        code: "custom",
        path: ["primaryEvidenceId"],
        message: "primaryEvidenceId must reference exactly one evidence entry",
      });
    }
  })
  .transform((record): PublishedProvisionVersion => ({
    ...record,
    evidence: toNonEmptyEvidence(record.evidence),
  }));

export const amendmentRecordSchema = z
  .object({
    amendmentId: domainValue(parseAmendmentId, maximumIdentifierLength),
    effectiveFrom: legalDateSchema,
    evidence: z.array(evidenceReferenceSchema).min(1).max(maximumEvidencePerRecord),
    relationType: z.enum(["amends", "repeals", "replaces", "corrects"]),
    reviewStatus: reviewStatusSchema,
    sourceProvisionId: domainValue(parseProvisionId, maximumIdentifierLength),
    targetProvisionId: domainValue(parseProvisionId, maximumIdentifierLength),
  })
  .strict()
  .transform((record): AmendmentRelation => ({
    ...record,
    evidence: toNonEmptyEvidence(record.evidence),
  }));

export const manualDatasetFileSchema = z
  .object({
    schemaVersion: z.literal(1),
    datasetReleaseId: domainValue(parseDatasetReleaseId, maximumIdentifierLength),
    provisionVersions: z
      .array(provisionVersionRecordSchema)
      .min(1)
      .max(maximumProvisionVersionRecords),
    amendments: z.array(amendmentRecordSchema).max(maximumAmendmentRecords),
  })
  .strict()
  .superRefine((file, ctx) => {
    const seenVersionIds = new Set<string>();
    file.provisionVersions.forEach((version, index) => {
      if (version.datasetReleaseId !== file.datasetReleaseId) {
        ctx.addIssue({
          code: "custom",
          path: ["provisionVersions", index, "datasetReleaseId"],
          message: "Record release must match the dataset file release",
        });
      }
      if (seenVersionIds.has(version.provisionVersionId)) {
        ctx.addIssue({
          code: "custom",
          path: ["provisionVersions", index, "provisionVersionId"],
          message: "provisionVersionId must be unique within a dataset file",
        });
      }
      seenVersionIds.add(version.provisionVersionId);
    });

    const seenAmendmentIds = new Set<string>();
    file.amendments.forEach((amendment, index) => {
      if (seenAmendmentIds.has(amendment.amendmentId)) {
        ctx.addIssue({
          code: "custom",
          path: ["amendments", index, "amendmentId"],
          message: "amendmentId must be unique within a dataset file",
        });
      }
      seenAmendmentIds.add(amendment.amendmentId);
    });
  });

export type ManualDatasetFile = z.output<typeof manualDatasetFileSchema>;

export function decodeManualDatasetFile(input: unknown): DecodeResult<ManualDatasetFile> {
  return runDecoder(manualDatasetFileSchema, input);
}
