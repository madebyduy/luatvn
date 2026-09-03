import {
  diffLegalText,
  parseDatasetReleaseId,
  parseIsoInstant,
  parseLegalDate,
  parseProvisionId,
  parseProvisionVersionId,
  resolveProvisionAt,
  type AmendmentRelation,
  type DatasetReleaseId,
  type DocumentId,
  type EvidenceReference,
  type IsoInstant,
  type LegalCitation,
  type LegalDate,
  type ProvisionId,
  type ProvisionVersionId,
  type PublishedProvisionVersion,
  type ServablePublishedProvisionVersion,
  type LegalReference,
  extractLegalReferences,
  isServableReviewStatus,
} from "@luatvn/domain";

import type { LegalReadOperation, LegalReadRepository } from "./ports/legal-read-repository.js";

const legalDataWarning = "LEGAL_DATA_NOT_ADVICE";
export const maximumProvisionVersionsPerQuery = 256;
export const maximumAmendmentRelationsPerTrace = 256;
export const maximumCatalogVersions = 5_000;

export interface QueryContextInput {
  readonly requestId: string;
  readonly datasetReleaseId: string;
  readonly knownAt: string;
}

export interface QueryExecutionInput {
  readonly deadlineAt: string;
  readonly signal: AbortSignal;
}

interface QueryContext {
  readonly requestId: string;
  readonly datasetReleaseId: DatasetReleaseId;
  readonly knownAt: IsoInstant;
}

interface QueryExecutionContext {
  readonly deadlineAt: IsoInstant;
  readonly signal: AbortSignal;
}

interface LegalEnvelope<Data> {
  readonly data: Data;
  readonly release: {
    readonly id: DatasetReleaseId;
  };
  readonly warnings: readonly [typeof legalDataWarning];
  readonly untrustedContent: true;
}

export type ReferenceResolutionReason =
  "NOT_IN_CORPUS" | "NOT_IN_FORCE_AT_DATE" | "AMBIGUOUS" | "UNSUPPORTED";

// A cross-reference found in the text, resolved at the same legal date the
// reader asked about. The reason names why a target is absent; nothing is
// guessed to fill it.
export interface ResolvedReference extends LegalReference {
  readonly target: {
    readonly provisionId: ProvisionId;
    readonly provisionVersionId: ProvisionVersionId;
  } | null;
  readonly reason: ReferenceResolutionReason | null;
}

export type GetProvisionAtOutput = LegalEnvelope<
  | {
      readonly status: "resolved";
      readonly provision: {
        readonly heading: string | null;
        readonly legalText: string;
        readonly provisionId: ProvisionId;
        readonly provisionVersionId: ProvisionVersionId;
      };
      readonly citation: LegalCitation;
      readonly references: readonly ResolvedReference[];
    }
  | {
      readonly status: "unknown";
      readonly reason: "NO_MATCHING_VERSION" | "MATCH_ONLY_UNVERIFIED";
      readonly candidateVersionIds: readonly ProvisionVersionId[];
    }
  | {
      readonly status: "conflict";
      readonly reason: "MULTIPLE_VERIFIED_VERSIONS";
      readonly candidateVersionIds: readonly ProvisionVersionId[];
    }
>;

export type CompareProvisionVersionsOutput = LegalEnvelope<{
  readonly status: "resolved";
  readonly provisionId: ProvisionId;
  readonly fromCitation: LegalCitation;
  readonly toCitation: LegalCitation;
  readonly chunks: ReturnType<typeof diffLegalText>;
}>;

export interface CatalogVersion {
  readonly provisionVersionId: ProvisionVersionId;
  readonly reviewStatus: PublishedProvisionVersion["reviewStatus"];
  readonly validFrom: LegalDate;
  readonly validTo: LegalDate | null;
}

export interface CatalogProvision {
  readonly heading: string | null;
  readonly provisionId: ProvisionId;
  readonly versions: readonly CatalogVersion[];
}

export interface CatalogDocument {
  readonly documentId: DocumentId;
  readonly documentNumber: string;
  readonly provisions: readonly CatalogProvision[];
}

export type GetCatalogOutput = LegalEnvelope<{
  readonly status: "resolved";
  readonly documents: readonly CatalogDocument[];
}>;

export type TraceAmendmentsOutput = LegalEnvelope<{
  readonly status: "resolved";
  readonly provisionId: ProvisionId;
  readonly relations: readonly AmendmentRelation[];
}>;

export class LegalQueryError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "VERSION_NOT_FOUND"
      | "CROSS_PROVISION_COMPARE"
      | "REQUEST_ABORTED"
      | "RESULT_LIMIT_EXCEEDED"
      | "UNVERIFIED_RELATION"
      | "UNVERIFIED_VERSION",
    message: string,
  ) {
    super(message);
    this.name = "LegalQueryError";
  }
}

function parseDomainInput<Value>(
  field: string,
  value: string,
  parser: (candidate: string) => Value,
): Value {
  try {
    return parser(value);
  } catch (error) {
    if (error instanceof TypeError || error instanceof RangeError) {
      throw new LegalQueryError("INVALID_INPUT", `${field} is invalid`);
    }
    throw error;
  }
}

function parseContext(input: QueryContextInput): QueryContext {
  if (input.requestId.length < 8 || input.requestId.length > 128) {
    throw new LegalQueryError("INVALID_INPUT", "requestId length is invalid");
  }

  return {
    requestId: input.requestId,
    datasetReleaseId: parseDomainInput(
      "context.datasetReleaseId",
      input.datasetReleaseId,
      parseDatasetReleaseId,
    ),
    knownAt: parseDomainInput("context.knownAt", input.knownAt, parseIsoInstant),
  };
}

function parseExecution(input: QueryExecutionInput): QueryExecutionContext {
  return {
    deadlineAt: parseDomainInput("execution.deadlineAt", input.deadlineAt, parseIsoInstant),
    signal: input.signal,
  };
}

function operationFor(context: QueryContext, execution: QueryExecutionContext): LegalReadOperation {
  return {
    requestId: context.requestId,
    deadlineAt: execution.deadlineAt,
    signal: execution.signal,
  };
}

function assertOperationActive(operation: LegalReadOperation): void {
  if (operation.signal.aborted) {
    throw new LegalQueryError(
      "REQUEST_ABORTED",
      "The request deadline or client cancellation was reached",
    );
  }
}

async function executeLegalRead<Value>(
  operation: LegalReadOperation,
  read: () => Promise<Value>,
): Promise<Value> {
  assertOperationActive(operation);
  try {
    const value = await read();
    assertOperationActive(operation);
    return value;
  } catch (error) {
    if (operation.signal.aborted) {
      throw new LegalQueryError(
        "REQUEST_ABORTED",
        "The request deadline or client cancellation was reached",
      );
    }
    throw error;
  }
}

function assertResultLimit(field: string, length: number, maximum: number): void {
  if (length > maximum) {
    throw new LegalQueryError("RESULT_LIMIT_EXCEEDED", `${field} exceeds the public result limit`);
  }
}

function isVerifiedVersion(
  version: PublishedProvisionVersion,
): version is ServablePublishedProvisionVersion {
  return isServableReviewStatus(version.reviewStatus);
}

function requireVerifiedVersion(
  version: PublishedProvisionVersion,
): ServablePublishedProvisionVersion {
  if (!isVerifiedVersion(version)) {
    throw new LegalQueryError(
      "UNVERIFIED_VERSION",
      "A requested version has not passed legal-data review",
    );
  }
  return version;
}

function primaryEvidenceFor(version: ServablePublishedProvisionVersion): EvidenceReference {
  const matches = version.evidence.filter(
    (evidence) => evidence.evidenceId === version.primaryEvidenceId,
  );
  const primaryEvidence = matches[0];
  if (matches.length !== 1 || primaryEvidence === undefined) {
    throw new Error("Published version primary evidence invariant failed");
  }
  return primaryEvidence;
}

function compactDocumentNumber(value: string): string {
  return value.normalize("NFC").replaceAll(/\s+/gu, "").toUpperCase();
}

function headingArticleNumber(heading: string | null): number | null {
  const match = heading === null ? null : /^Điều\s+(\d+)\b/u.exec(heading.normalize("NFC"));
  return match === null ? null : Number(match[1]);
}

// Resolves one reference to a provision version in force at validAt. Chapter
// references have no provision to land on; titled laws cannot be matched
// because the catalog carries document numbers, not titles. Both are reported
// as such rather than approximated.
function resolveOneReference(
  reference: LegalReference,
  current: PublishedProvisionVersion,
  catalog: readonly PublishedProvisionVersion[],
  validAt: LegalDate,
  knownAt: IsoInstant,
  datasetReleaseId: DatasetReleaseId,
): ResolvedReference {
  const unresolved = (reason: ReferenceResolutionReason): ResolvedReference => ({
    ...reference,
    reason,
    target: null,
  });

  if (reference.chapter !== null) {
    return unresolved("UNSUPPORTED");
  }
  if (reference.kind === "named_document") {
    return unresolved("NOT_IN_CORPUS");
  }

  let scope: readonly PublishedProvisionVersion[];
  if (reference.kind === "same_document") {
    if (reference.article === null) {
      // "khoản 2 Điều này": the provision being read.
      return {
        ...reference,
        reason: null,
        target: {
          provisionId: current.provisionId,
          provisionVersionId: current.provisionVersionId,
        },
      };
    }
    scope = catalog.filter((version) => version.documentId === current.documentId);
  } else {
    const wanted = compactDocumentNumber(reference.documentNumber ?? "");
    scope = catalog.filter((version) => compactDocumentNumber(version.documentNumber) === wanted);
    if (scope.length === 0) {
      return unresolved("NOT_IN_CORPUS");
    }
    if (reference.article === null) {
      return unresolved("UNSUPPORTED");
    }
  }

  const candidates = scope.filter(
    (version) => headingArticleNumber(version.heading) === reference.article,
  );
  const provisionIds = new Set(candidates.map((version) => version.provisionId));
  if (provisionIds.size === 0) {
    return unresolved("NOT_IN_CORPUS");
  }
  if (provisionIds.size > 1) {
    return unresolved("AMBIGUOUS");
  }
  const [provisionId] = provisionIds;
  if (provisionId === undefined) {
    return unresolved("NOT_IN_CORPUS");
  }
  const resolved = resolveProvisionAt({
    datasetReleaseId,
    knownAt,
    provisionId,
    validAt,
    versions: candidates,
  });
  if (resolved.status !== "resolved") {
    return unresolved(resolved.status === "conflict" ? "AMBIGUOUS" : "NOT_IN_FORCE_AT_DATE");
  }
  return {
    ...reference,
    reason: null,
    target: {
      provisionId: resolved.version.provisionId,
      provisionVersionId: resolved.version.provisionVersionId,
    },
  };
}

function resolveReferencesIn(
  current: PublishedProvisionVersion,
  catalog: readonly PublishedProvisionVersion[],
  validAt: LegalDate,
  knownAt: IsoInstant,
  datasetReleaseId: DatasetReleaseId,
): readonly ResolvedReference[] {
  return extractLegalReferences(current.legalText).map((reference) =>
    resolveOneReference(reference, current, catalog, validAt, knownAt, datasetReleaseId),
  );
}

function citationFor(
  version: ServablePublishedProvisionVersion,
  validAt: LegalDate,
  checkedAt: IsoInstant,
): LegalCitation {
  const evidence = primaryEvidenceFor(version);
  return {
    provisionId: version.provisionId,
    provisionVersionId: version.provisionVersionId,
    documentNumber: version.documentNumber,
    sourceUrl: evidence.officialSourceUrl,
    sourceSha256: evidence.sourceSha256,
    retrievedAt: evidence.retrievedAt,
    validAt,
    validityStatus: "effective",
    checkedAt,
    datasetReleaseId: version.datasetReleaseId,
    reviewStatus: version.reviewStatus,
    locator: evidence.locator,
  };
}

function envelope<Data>(data: Data, releaseId: DatasetReleaseId): LegalEnvelope<Data> {
  return {
    data,
    release: { id: releaseId },
    warnings: [legalDataWarning],
    untrustedContent: true,
  };
}

export class LegalQueryService {
  public constructor(private readonly repository: LegalReadRepository) {}

  public async getProvisionAt(
    input: {
      readonly context: QueryContextInput;
      readonly provisionId: string;
      readonly validAt: string;
    },
    executionInput: QueryExecutionInput,
  ): Promise<GetProvisionAtOutput> {
    const context = parseContext(input.context);
    const execution = parseExecution(executionInput);
    const operation = operationFor(context, execution);
    const provisionId = parseDomainInput("provisionId", input.provisionId, parseProvisionId);
    const validAt = parseDomainInput("validAt", input.validAt, parseLegalDate);
    const versions = await executeLegalRead(operation, () =>
      this.repository.listPublishedProvisionVersions(
        provisionId,
        context.datasetReleaseId,
        operation,
      ),
    );
    assertResultLimit(
      "Published provision versions",
      versions.length,
      maximumProvisionVersionsPerQuery,
    );
    const resolution = resolveProvisionAt({
      versions,
      provisionId,
      validAt,
      knownAt: context.knownAt,
      datasetReleaseId: context.datasetReleaseId,
    });

    if (resolution.status === "unknown") {
      return envelope(
        {
          status: "unknown",
          reason: resolution.reason,
          candidateVersionIds: resolution.candidateVersionIds,
        },
        context.datasetReleaseId,
      );
    }

    if (resolution.status === "conflict") {
      return envelope(
        {
          status: "conflict",
          reason: resolution.reason,
          candidateVersionIds: resolution.candidateVersionIds,
        },
        context.datasetReleaseId,
      );
    }

    // Cross-references are resolved against the catalog at the same legal
    // date, so "Điều 7 của Nghị định này" read on a 2023 date links to the
    // 2023 text of Điều 7, not today's. The catalog read is bounded.
    const catalog = await executeLegalRead(operation, () =>
      this.repository.listCatalogVersions(context.datasetReleaseId, operation),
    );
    assertResultLimit("Catalog versions", catalog.length, maximumCatalogVersions);
    const references = resolveReferencesIn(
      resolution.version,
      catalog,
      validAt,
      context.knownAt,
      context.datasetReleaseId,
    );

    return envelope(
      {
        status: "resolved",
        provision: {
          heading: resolution.version.heading,
          legalText: resolution.version.legalText,
          provisionId: resolution.version.provisionId,
          provisionVersionId: resolution.version.provisionVersionId,
        },
        citation: citationFor(resolution.version, validAt, context.knownAt),
        references,
      },
      context.datasetReleaseId,
    );
  }

  public async compareProvisionVersions(
    input: {
      readonly context: QueryContextInput;
      readonly fromVersionId: string;
      readonly toVersionId: string;
    },
    executionInput: QueryExecutionInput,
  ): Promise<CompareProvisionVersionsOutput> {
    const context = parseContext(input.context);
    const execution = parseExecution(executionInput);
    const operation = operationFor(context, execution);
    const fromVersionId = parseDomainInput(
      "fromVersionId",
      input.fromVersionId,
      parseProvisionVersionId,
    );
    const toVersionId = parseDomainInput("toVersionId", input.toVersionId, parseProvisionVersionId);
    const [fromVersion, toVersion] = await executeLegalRead(operation, () =>
      Promise.all([
        this.repository.getPublishedProvisionVersion(
          fromVersionId,
          context.datasetReleaseId,
          operation,
        ),
        this.repository.getPublishedProvisionVersion(
          toVersionId,
          context.datasetReleaseId,
          operation,
        ),
      ]),
    );

    if (fromVersion === null || toVersion === null) {
      throw new LegalQueryError("VERSION_NOT_FOUND", "A requested published version was not found");
    }
    const verifiedFromVersion = requireVerifiedVersion(fromVersion);
    const verifiedToVersion = requireVerifiedVersion(toVersion);
    if (verifiedFromVersion.provisionId !== verifiedToVersion.provisionId) {
      throw new LegalQueryError(
        "CROSS_PROVISION_COMPARE",
        "Only versions of the same stable provision may be compared",
      );
    }
    assertOperationActive(operation);

    return envelope(
      {
        status: "resolved",
        provisionId: verifiedFromVersion.provisionId,
        fromCitation: citationFor(
          verifiedFromVersion,
          verifiedFromVersion.validTime.from,
          context.knownAt,
        ),
        toCitation: citationFor(
          verifiedToVersion,
          verifiedToVersion.validTime.from,
          context.knownAt,
        ),
        chunks: diffLegalText(verifiedFromVersion.legalText, verifiedToVersion.legalText),
      },
      context.datasetReleaseId,
    );
  }

  // Shapes the published versions into documents and provisions. It reports
  // what exists in the release; deciding which version applies at a date stays
  // with getProvisionAt so the resolution rule is never duplicated.
  public async getCatalog(
    input: { readonly context: QueryContextInput },
    executionInput: QueryExecutionInput,
  ): Promise<GetCatalogOutput> {
    const context = parseContext(input.context);
    const execution = parseExecution(executionInput);
    const operation = operationFor(context, execution);
    const versions = await executeLegalRead(operation, () =>
      this.repository.listCatalogVersions(context.datasetReleaseId, operation),
    );
    assertResultLimit("Catalog versions", versions.length, maximumCatalogVersions);

    const documents = new Map<
      DocumentId,
      { documentNumber: string; provisions: Map<ProvisionId, CatalogProvision> }
    >();
    for (const version of versions) {
      const document = documents.get(version.documentId) ?? {
        documentNumber: version.documentNumber,
        provisions: new Map<ProvisionId, CatalogProvision>(),
      };
      const existing = document.provisions.get(version.provisionId);
      const entry: CatalogVersion = {
        provisionVersionId: version.provisionVersionId,
        reviewStatus: version.reviewStatus,
        validFrom: version.validTime.from,
        validTo: version.validTime.to,
      };
      document.provisions.set(version.provisionId, {
        heading: existing?.heading ?? version.heading,
        provisionId: version.provisionId,
        versions: [...(existing?.versions ?? []), entry],
      });
      documents.set(version.documentId, document);
    }

    return envelope(
      {
        status: "resolved",
        documents: [...documents.entries()].map(([documentId, document]) => ({
          documentId,
          documentNumber: document.documentNumber,
          provisions: [...document.provisions.values()].map((provision) =>
            Object.assign({}, provision, {
              versions: provision.versions.toSorted((left, right) =>
                left.validFrom.localeCompare(right.validFrom),
              ),
            }),
          ),
        })),
      },
      context.datasetReleaseId,
    );
  }

  public async traceAmendments(
    input: {
      readonly context: QueryContextInput;
      readonly provisionId: string;
      readonly maxDepth: 1 | 2;
    },
    executionInput: QueryExecutionInput,
  ): Promise<TraceAmendmentsOutput> {
    const context = parseContext(input.context);
    const execution = parseExecution(executionInput);
    const operation = operationFor(context, execution);
    const provisionId = parseDomainInput("provisionId", input.provisionId, parseProvisionId);
    const relations = await executeLegalRead(operation, () =>
      this.repository.listVerifiedAmendments(
        provisionId,
        context.datasetReleaseId,
        input.maxDepth,
        operation,
      ),
    );
    assertResultLimit(
      "Verified amendment relations",
      relations.length,
      maximumAmendmentRelationsPerTrace,
    );

    if (relations.some((relation) => relation.reviewStatus !== "verified")) {
      throw new LegalQueryError(
        "UNVERIFIED_RELATION",
        "The repository returned an amendment relation that is not verified",
      );
    }

    return envelope({ status: "resolved", provisionId, relations }, context.datasetReleaseId);
  }
}
