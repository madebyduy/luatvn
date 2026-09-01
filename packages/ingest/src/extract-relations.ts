export type VbplRelationType = "amends" | "repeals" | "replaces" | "corrects";

export interface VbplDocumentRelation {
  readonly relationType: VbplRelationType;
  readonly targetSourceId: string;
  readonly targetName: string;
}

export interface VbplUnmappedRelation {
  readonly code: string;
  readonly documentCount: number;
}

export interface VbplRelationsResult {
  readonly relations: readonly VbplDocumentRelation[];
  // Codes observed in the payload that this extractor does not map. They are
  // reported, never guessed: a human decides what an unknown code means.
  readonly unmapped: readonly VbplUnmappedRelation[];
}

// Relation codes verified empirically against vbpl.vn on 2026-09-01 by comparing
// the payload with the labels rendered on the "Luoc do" tab:
//   10 -> "Van ban duoc sua doi bo sung" (this document amends the listed one)
//   12 -> "Van ban duoc thay the"        (this document replaces the listed one)
// Code 3 is "Can cu ban hanh" - a legal basis citation, not an amendment, so it
// is intentionally excluded from amendment relations rather than reported.
const amendmentTypeByCode = new Map<string, VbplRelationType>([
  ["10", "amends"],
  ["12", "replaces"],
]);
const knownNonAmendmentCodes = new Set(["3"]);

interface RelationDocument {
  readonly id: unknown;
  readonly name: unknown;
}

function relationPayloadFrom(flightText: string): Record<string, unknown> | null {
  for (const line of flightText.split("\n")) {
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const body = line.slice(separator + 1);
    if (!body.startsWith("{") || !body.includes("documentNamesByType")) continue;
    try {
      const parsed: unknown = JSON.parse(body);
      if (typeof parsed === "object" && parsed !== null) {
        const byType = (parsed as { documentNamesByType?: unknown }).documentNamesByType;
        if (typeof byType === "object" && byType !== null) {
          return byType as Record<string, unknown>;
        }
      }
    } catch {
      // Not the relation payload line; keep scanning.
    }
  }
  return null;
}

// Reads the document-level relation graph ("Luoc do") of a vbpl.vn document.
// Relations are document-level at the source; turning them into provision-level
// amendments happens in link-amendments.ts and always stays under_review.
export function extractVbplRelations(flightText: string): VbplRelationsResult {
  const byType = relationPayloadFrom(flightText);
  if (byType === null) {
    return { relations: [], unmapped: [] };
  }

  const relations: VbplDocumentRelation[] = [];
  const unmapped: VbplUnmappedRelation[] = [];
  for (const [code, rawDocuments] of Object.entries(byType)) {
    if (!Array.isArray(rawDocuments) || rawDocuments.length === 0) continue;
    const documents = rawDocuments as RelationDocument[];
    const relationType = amendmentTypeByCode.get(code);
    if (relationType === undefined) {
      if (!knownNonAmendmentCodes.has(code)) {
        unmapped.push({ code, documentCount: documents.length });
      }
      continue;
    }
    for (const document of documents) {
      if (typeof document.id !== "string" || typeof document.name !== "string") continue;
      relations.push({
        relationType,
        targetName: document.name,
        targetSourceId: document.id,
      });
    }
  }
  return { relations, unmapped };
}
