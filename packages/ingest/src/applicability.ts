import type { ApplicabilityCondition, ManualDatasetFile } from "@luatvn/manual-dataset";

// Machine proposals for "does this apply to me?" (UX-130). Vietnamese
// normative documents state their scope in a dedicated article - "Điều 2. Đối
// tượng áp dụng" - as a list of subjects, one per clause. That article is the
// one place where the source itself says who is bound, so each clause becomes
// a proposed condition, quoted verbatim, capped at under_review. Deciding
// whether the proposal is right is a legal reading, and only a person may do
// it; the machine never marks one verified and never rewrites the wording.

const scopeHeading = /^Điều\s+\d+\s*[.:]\s*Đối tượng áp dụng/iu;
const clauseLine = /^(\d+)\.\s+(?<text>.+)$/u;

export interface ApplicabilityProposalReport {
  readonly proposed: number;
  /** Provisions headed "Đối tượng áp dụng" whose text yielded no clause to quote. */
  readonly scopeArticlesWithoutClauses: readonly string[];
}

export interface ApplicabilityProposalResult {
  readonly conditions: readonly ApplicabilityCondition[];
  readonly report: ApplicabilityProposalReport;
}

function subjectOf(text: string): string {
  // "Doanh nghiệp, tổ chức, cá nhân trong và ngoài nước cung cấp ..." - the
  // subject is the noun phrase before the first verb-like connector. Cut at the
  // first comma-free run of up to eight words; the full clause stays in
  // `condition`, so nothing is lost if this heuristic cuts short.
  const words = text.replace(/[.;]$/u, "").split(/\s+/u);
  return words.slice(0, Math.min(words.length, 8)).join(" ");
}

export function proposeApplicability(draft: ManualDatasetFile): ApplicabilityProposalResult {
  const conditions: ApplicabilityCondition[] = [];
  const scopeArticlesWithoutClauses: string[] = [];
  for (const version of draft.provisionVersions) {
    if (version.heading === null || !scopeHeading.test(version.heading.normalize("NFC"))) {
      continue;
    }
    const lines = version.legalText.split("\n").slice(1);
    let clausesFound = 0;
    for (const line of lines) {
      const match = clauseLine.exec(line.normalize("NFC").trim());
      const text = match?.groups?.["text"];
      if (match === null || text === undefined) {
        continue;
      }
      clausesFound += 1;
      conditions.push({
        applies: true,
        condition: text,
        conditionId: `cond_${version.provisionVersionId}_k${match[1] ?? String(clausesFound)}`,
        evidence: version.evidence,
        provisionId: version.provisionId,
        reviewStatus: "under_review",
        subject: subjectOf(text),
      });
    }
    if (clausesFound === 0) {
      scopeArticlesWithoutClauses.push(version.provisionVersionId);
    }
  }
  return {
    conditions,
    report: { proposed: conditions.length, scopeArticlesWithoutClauses },
  };
}
