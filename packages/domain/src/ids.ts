declare const identifierBrand: unique symbol;

type Identifier<Tag extends string> = string & {
  readonly [identifierBrand]: Tag;
};

export type DocumentId = Identifier<"DocumentId">;
export type ProvisionId = Identifier<"ProvisionId">;
export type ProvisionVersionId = Identifier<"ProvisionVersionId">;
export type DatasetReleaseId = Identifier<"DatasetReleaseId">;
export type EvidenceId = Identifier<"EvidenceId">;
export type AmendmentId = Identifier<"AmendmentId">;

const identifierPattern = /^[a-z][a-z0-9]*(?:_[a-zA-Z0-9][a-zA-Z0-9_-]*)+$/u;

function parseIdentifier<Tag extends string>(
  value: string,
  prefix: string,
  field: string,
): Identifier<Tag> {
  if (!value.startsWith(`${prefix}_`) || !identifierPattern.test(value)) {
    throw new TypeError(
      `${field} must start with "${prefix}_" and contain only safe ID characters`,
    );
  }

  return value as Identifier<Tag>;
}

export const parseDocumentId = (value: string): DocumentId =>
  parseIdentifier<"DocumentId">(value, "doc", "documentId");

export const parseProvisionId = (value: string): ProvisionId =>
  parseIdentifier<"ProvisionId">(value, "prov", "provisionId");

export const parseProvisionVersionId = (value: string): ProvisionVersionId =>
  parseIdentifier<"ProvisionVersionId">(value, "pv", "provisionVersionId");

export const parseDatasetReleaseId = (value: string): DatasetReleaseId =>
  parseIdentifier<"DatasetReleaseId">(value, "rel", "datasetReleaseId");

export const parseEvidenceId = (value: string): EvidenceId =>
  parseIdentifier<"EvidenceId">(value, "ev", "evidenceId");

export const parseAmendmentId = (value: string): AmendmentId =>
  parseIdentifier<"AmendmentId">(value, "amd", "amendmentId");
