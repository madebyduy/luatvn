import { DocumentFetcher, IngestError, type FetchedDocument } from "./fetcher.js";

// Next-Action ids observed on vbpl.vn on 2026-09-01. They are build-specific and
// change when the site redeploys; pass an override when that happens.
export const defaultVbplContentAction = "0fb12b3561faa05adec51a82efb3e4f4f427f07b";
export const defaultVbplRelationsAction = "4a3423ce75290ef83a022333ee187acf4d38d3fb";

export function vbplDocumentIdFromUrl(detailUrl: string): string {
  const pathname = new URL(detailUrl).pathname;
  const lastSegment = pathname.split("/").findLast((segment) => segment.length > 0) ?? "";
  const doubleDash = lastSegment.lastIndexOf("--");
  return doubleDash === -1 ? lastSegment : lastSegment.slice(doubleDash + 2);
}

async function fetchVbplAction(
  fetcher: DocumentFetcher,
  detailUrl: string,
  action: string,
): Promise<FetchedDocument> {
  const documentId = vbplDocumentIdFromUrl(detailUrl);
  if (documentId.length === 0) {
    throw new IngestError("INVALID_URL", "Detail URL carries no document id segment");
  }
  return fetcher.fetchDocument(detailUrl, {
    body: JSON.stringify([documentId]),
    headers: {
      accept: "text/x-component",
      "content-type": "text/plain;charset=UTF-8",
      "next-action": action,
    },
    method: "POST",
  });
}

// Fetches the server-rendered content payload (metadata + provision HTML) of a
// vbpl.vn detail page. Politeness, host and robots rules of the fetcher apply.
export function fetchVbplContentFlight(
  fetcher: DocumentFetcher,
  detailUrl: string,
  contentAction: string = defaultVbplContentAction,
): Promise<FetchedDocument> {
  return fetchVbplAction(fetcher, detailUrl, contentAction);
}

// Fetches the document relation graph ("Luoc do" tab).
export function fetchVbplRelationsFlight(
  fetcher: DocumentFetcher,
  detailUrl: string,
  relationsAction: string = defaultVbplRelationsAction,
): Promise<FetchedDocument> {
  return fetchVbplAction(fetcher, detailUrl, relationsAction);
}

export function vbplDetailUrl(sourceDocumentId: string): string {
  return `https://vbpl.vn/van-ban/chi-tiet/${sourceDocumentId}`;
}
