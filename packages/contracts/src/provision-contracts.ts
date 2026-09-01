import { z } from "zod";

const safeIdentifierPattern = /^[a-z][a-z0-9]*(?:_[a-zA-Z0-9][a-zA-Z0-9_-]*)+$/u;
const legalDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/u;
const canonicalInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const sha256Pattern = /^[a-f0-9]{64}$/u;

function isRealLegalDate(value: string): boolean {
  const match = legalDatePattern.exec(value);
  if (match === null) return false;

  const yearText = match[1];
  const monthText = match[2];
  const dayText = match[3];
  if (yearText === undefined || monthText === undefined || dayText === undefined) return false;

  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const candidate = new Date(Date.UTC(year, month - 1, day));

  return (
    candidate.getUTCFullYear() === year &&
    candidate.getUTCMonth() === month - 1 &&
    candidate.getUTCDate() === day
  );
}

function isCanonicalIsoInstant(value: string): boolean {
  const candidate = new Date(value);
  return !Number.isNaN(candidate.getTime()) && candidate.toISOString() === value;
}

export const ProvisionIdSchema = z
  .string()
  .regex(/^prov_/u)
  .regex(safeIdentifierPattern);
export const ProvisionVersionIdSchema = z.string().regex(/^pv_/u).regex(safeIdentifierPattern);
export const DatasetReleaseIdSchema = z.string().regex(/^rel_/u).regex(safeIdentifierPattern);
export const LegalDateSchema = z
  .string()
  .regex(legalDatePattern)
  .refine(isRealLegalDate, "Legal date must be a real calendar date");
export const IsoInstantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine(isCanonicalIsoInstant, "Instant must be a real canonical UTC instant");
export const Sha256Schema = z.string().regex(sha256Pattern);

export const QueryContextSchema = z
  .object({
    datasetReleaseId: DatasetReleaseIdSchema,
    knownAt: IsoInstantSchema,
    requestId: z.string().min(8).max(128),
  })
  .strict();

export const GetProvisionAtRequestSchema = z
  .object({
    context: QueryContextSchema,
    provisionId: ProvisionIdSchema,
    validAt: LegalDateSchema,
  })
  .strict();

export const CompareProvisionVersionsRequestSchema = z
  .object({
    context: QueryContextSchema,
    fromVersionId: ProvisionVersionIdSchema,
    toVersionId: ProvisionVersionIdSchema,
  })
  .strict();

export const TraceAmendmentsRequestSchema = z
  .object({
    context: QueryContextSchema,
    maxDepth: z.union([z.literal(1), z.literal(2)]),
    provisionId: ProvisionIdSchema,
  })
  .strict();

export const GetCatalogRequestSchema = z.object({ context: QueryContextSchema }).strict();

const CatalogVersionSchema = z
  .object({
    provisionVersionId: ProvisionVersionIdSchema,
    reviewStatus: z.enum(["verified", "under_review", "unverified"]),
    validFrom: LegalDateSchema,
    validTo: LegalDateSchema.nullable(),
  })
  .strict();

const CatalogProvisionSchema = z
  .object({
    heading: z.string().max(1_024).nullable(),
    provisionId: ProvisionIdSchema,
    versions: z.array(CatalogVersionSchema).readonly(),
  })
  .strict();

const CatalogDocumentSchema = z
  .object({
    documentId: z.string().regex(/^doc_/u).regex(safeIdentifierPattern),
    documentNumber: z.string().min(1).max(256),
    provisions: z.array(CatalogProvisionSchema).readonly(),
  })
  .strict();

export const EvidenceSchema = z
  .object({
    evidenceId: z.string().regex(/^ev_/u).regex(safeIdentifierPattern),
    locator: z.string().max(512).nullable(),
    officialSourceUrl: z.string().url().max(2_048),
    retrievedAt: IsoInstantSchema,
    sourceSha256: Sha256Schema,
  })
  .strict();

export const CitationSchema = z
  .object({
    checkedAt: IsoInstantSchema,
    datasetReleaseId: DatasetReleaseIdSchema,
    documentNumber: z.string().min(1).max(256),
    locator: z.string().max(512).nullable(),
    provisionId: ProvisionIdSchema,
    provisionVersionId: ProvisionVersionIdSchema,
    retrievedAt: IsoInstantSchema,
    reviewStatus: z.enum(["verified", "under_review", "unverified"]),
    sourceSha256: Sha256Schema,
    sourceUrl: z.string().url().max(2_048),
    validAt: LegalDateSchema,
    validityStatus: z.enum(["effective", "not_effective", "unknown"]),
  })
  .strict();

export const ErrorResponseSchema = z
  .object({
    error: z
      .object({
        code: z.string().min(1).max(64),
        message: z.string().min(1).max(512),
        requestId: z.string().min(1).max(128),
      })
      .strict(),
  })
  .strict();

const ReleaseSchema = z.object({ id: DatasetReleaseIdSchema }).strict();
const WarningSchema = z.tuple([z.literal("LEGAL_DATA_NOT_ADVICE")]).readonly();

const UnknownProvisionDataSchema = z
  .object({
    candidateVersionIds: z.array(ProvisionVersionIdSchema).readonly(),
    reason: z.enum(["NO_MATCHING_VERSION", "MATCH_ONLY_UNVERIFIED"]),
    status: z.literal("unknown"),
  })
  .strict();

const ConflictedProvisionDataSchema = z
  .object({
    candidateVersionIds: z.array(ProvisionVersionIdSchema).readonly(),
    reason: z.literal("MULTIPLE_VERIFIED_VERSIONS"),
    status: z.literal("conflict"),
  })
  .strict();

const ResolvedProvisionDataSchema = z
  .object({
    citation: CitationSchema,
    provision: z
      .object({
        heading: z.string().max(1_024).nullable(),
        legalText: z.string().min(1),
        provisionId: ProvisionIdSchema,
        provisionVersionId: ProvisionVersionIdSchema,
      })
      .strict(),
    status: z.literal("resolved"),
  })
  .strict();

export const GetProvisionAtResponseSchema = z
  .object({
    data: z.union([
      ResolvedProvisionDataSchema,
      UnknownProvisionDataSchema,
      ConflictedProvisionDataSchema,
    ]),
    release: ReleaseSchema,
    untrustedContent: z.literal(true),
    warnings: WarningSchema,
  })
  .strict();

const DiffChunkSchema = z
  .object({
    lines: z.array(z.string()).readonly(),
    operation: z.enum(["unchanged", "added", "removed"]),
  })
  .strict();

export const CompareProvisionVersionsResponseSchema = z
  .object({
    data: z
      .object({
        chunks: z.array(DiffChunkSchema).readonly(),
        fromCitation: CitationSchema,
        provisionId: ProvisionIdSchema,
        status: z.literal("resolved"),
        toCitation: CitationSchema,
      })
      .strict(),
    release: ReleaseSchema,
    untrustedContent: z.literal(true),
    warnings: WarningSchema,
  })
  .strict();

const AmendmentRelationSchema = z
  .object({
    amendmentId: z.string().regex(/^amd_/u).regex(safeIdentifierPattern),
    effectiveFrom: LegalDateSchema,
    evidence: z.array(EvidenceSchema).min(1).readonly(),
    relationType: z.enum(["amends", "repeals", "replaces", "corrects"]),
    reviewStatus: z.enum(["verified", "under_review", "unverified"]),
    sourceProvisionId: ProvisionIdSchema,
    targetProvisionId: ProvisionIdSchema,
  })
  .strict();

export const TraceAmendmentsResponseSchema = z
  .object({
    data: z
      .object({
        provisionId: ProvisionIdSchema,
        relations: z.array(AmendmentRelationSchema).readonly(),
        status: z.literal("resolved"),
      })
      .strict(),
    release: ReleaseSchema,
    untrustedContent: z.literal(true),
    warnings: WarningSchema,
  })
  .strict();

export const GetCatalogResponseSchema = z
  .object({
    data: z
      .object({
        documents: z.array(CatalogDocumentSchema).readonly(),
        status: z.literal("resolved"),
      })
      .strict(),
    release: ReleaseSchema,
    untrustedContent: z.literal(true),
    warnings: WarningSchema,
  })
  .strict();

export type GetCatalogRequest = z.infer<typeof GetCatalogRequestSchema>;
export type GetCatalogResponse = z.infer<typeof GetCatalogResponseSchema>;
export type GetProvisionAtRequest = z.infer<typeof GetProvisionAtRequestSchema>;
export type CompareProvisionVersionsRequest = z.infer<typeof CompareProvisionVersionsRequestSchema>;
export type TraceAmendmentsRequest = z.infer<typeof TraceAmendmentsRequestSchema>;

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type GetProvisionAtResponse = z.infer<typeof GetProvisionAtResponseSchema>;
export type CompareProvisionVersionsResponse = z.infer<
  typeof CompareProvisionVersionsResponseSchema
>;
export type TraceAmendmentsResponse = z.infer<typeof TraceAmendmentsResponseSchema>;
