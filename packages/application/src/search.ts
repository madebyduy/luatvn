import type { PublishedProvisionVersion } from "@luatvn/domain";

// Tier 0 of "ask in plain language": rank provisions against a situation typed
// in ordinary words, with no model and no network. It is a lexical baseline -
// BM25 over diacritic-folded word tokens plus adjacent-word bigrams - and it is
// honest about what that means: "nợ lương" will find articles about "lương",
// not articles that say "chậm trả" without the word. The retriever is a
// replaceable step; a semantic one slots in behind the same interface once it
// has been measured on real questions (UX-100 AQ-001).

export interface SearchHit {
  readonly version: PublishedProvisionVersion;
  readonly score: number;
  /** A short window of the legal text around the strongest match. */
  readonly snippet: string;
}

export interface LexicalSearchOptions {
  readonly limit: number;
  /** Below this normalised score the corpus is treated as having nothing relevant. */
  readonly minimumScore?: number;
}

const defaultMinimumScore = 0.15;

// Folding: NFC, lowercase, strip combining marks, Đ -> D. A reader types with or
// without diacritics and either should hit the same words.
export function foldForSearch(text: string): string {
  return text.normalize("NFD").replaceAll(/\p{M}/gu, "").replaceAll(/[Đđ]/gu, "d").toLowerCase();
}

const stopWords = new Set([
  "va",
  "hoac",
  "cua",
  "la",
  "co",
  "cho",
  "theo",
  "tai",
  "trong",
  "voi",
  "ve",
  "duoc",
  "cac",
  "nhung",
  "mot",
  "nay",
  "do",
  "khi",
  "thi",
  "de",
  "tu",
  "den",
  "bi",
  "toi",
  "tôi",
  "minh",
  "roi",
  "nhi",
  "a",
  "khong",
  "gi",
]);

export function tokenize(text: string): readonly string[] {
  const words = foldForSearch(text).match(/[\p{L}\p{N}]+/gu) ?? [];
  const kept = words.filter((word) => word.length > 1 && !stopWords.has(word));
  const bigrams: string[] = [];
  for (let index = 0; index + 1 < kept.length; index += 1) {
    bigrams.push(`${kept[index] ?? ""}_${kept[index + 1] ?? ""}`);
  }
  return [...kept, ...bigrams];
}

interface IndexedDocument {
  readonly version: PublishedProvisionVersion;
  readonly terms: Map<string, number>;
  readonly length: number;
}

function indexDocument(version: PublishedProvisionVersion): IndexedDocument {
  const terms = new Map<string, number>();
  // The heading names the subject; weight it by repeating it.
  const text = `${version.heading ?? ""} ${version.heading ?? ""} ${version.legalText}`;
  const tokens = tokenize(text);
  for (const token of tokens) {
    terms.set(token, (terms.get(token) ?? 0) + 1);
  }
  return { length: tokens.length, terms, version };
}

function snippetFor(version: PublishedProvisionVersion, queryTokens: readonly string[]): string {
  const lines = version.legalText.split("\n");
  let best = lines[0] ?? "";
  let bestHits = -1;
  const wanted = new Set(queryTokens.filter((token) => !token.includes("_")));
  for (const line of lines) {
    const folded = foldForSearch(line);
    let hits = 0;
    for (const token of wanted) {
      if (folded.includes(token)) hits += 1;
    }
    if (hits > bestHits) {
      bestHits = hits;
      best = line;
    }
  }
  return best.length > 240 ? `${best.slice(0, 237)}…` : best;
}

/**
 * BM25 (k1 = 1.2, b = 0.75) over the given provisions. Scores are normalised to
 * the best possible score for the query so a caller can apply one threshold
 * regardless of corpus size. Returns nothing rather than the least-bad match
 * when nothing clears the threshold - "kho chưa có" is a real answer.
 */
export function lexicalSearch(
  versions: readonly PublishedProvisionVersion[],
  query: string,
  options: LexicalSearchOptions,
): readonly SearchHit[] {
  const queryTokens = [...new Set(tokenize(query))];
  if (queryTokens.length === 0 || versions.length === 0) {
    return [];
  }
  const documents = versions.map(indexDocument);
  const averageLength =
    documents.reduce((sum, document) => sum + document.length, 0) / documents.length;
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const term of document.terms.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const k1 = 1.2;
  const b = 0.75;
  const idf = (term: string): number => {
    const n = documentFrequency.get(term) ?? 0;
    return Math.log(1 + (documents.length - n + 0.5) / (n + 0.5));
  };
  // The ceiling: every query term THAT EXISTS SOMEWHERE IN THE CORPUS, present
  // with saturating frequency. Terms the corpus has never seen - the reader's
  // own words, bigrams that never formed - carry the highest idf of all and
  // would otherwise dominate the denominator, pushing every real match under
  // the threshold. If no query term exists in the corpus there is nothing to
  // rank, and the caller reports that.
  const known = queryTokens.filter((term) => (documentFrequency.get(term) ?? 0) > 0);
  if (known.length === 0) {
    return [];
  }
  const ceiling = known.reduce((sum, term) => sum + idf(term) * (k1 + 1), 0);

  const scored = documents
    .map((document) => {
      let score = 0;
      for (const term of queryTokens) {
        const frequency = document.terms.get(term) ?? 0;
        if (frequency === 0) continue;
        const weight = idf(term);
        const normalised =
          (frequency * (k1 + 1)) /
          (frequency + k1 * (1 - b + (b * document.length) / Math.max(averageLength, 1)));
        score += weight * normalised;
      }
      return { document, score: ceiling === 0 ? 0 : score / ceiling };
    })
    .filter((entry) => entry.score >= (options.minimumScore ?? defaultMinimumScore))
    .toSorted((left, right) => right.score - left.score)
    .slice(0, options.limit);

  return scored.map((entry) => ({
    score: Math.round(entry.score * 1000) / 1000,
    snippet: snippetFor(entry.document.version, queryTokens),
    version: entry.document.version,
  }));
}
