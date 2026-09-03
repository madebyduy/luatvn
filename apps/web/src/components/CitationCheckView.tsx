import { useState, type FormEvent } from "react";

import { ApiError, checkCitation, type CitationCheckResponse, type QueryContext } from "../api.js";
import { emptyState, toSearchString } from "../url-state.js";

// Paste a legal citation from anywhere - an article, a contract, a message -
// and get three answers kept apart: does the article exist in the corpus, was
// a version in force on that date, and does the quoted wording match it. The
// three are never collapsed into one verdict, because "the law exists" and
// "your quotation of it is right" are different claims.

const matchText: Record<string, { readonly label: string; readonly tone: string }> = {
  close: { label: "Gần khớp - có khác biệt nhỏ, xem lại từng chữ", tone: "warn" },
  different: { label: "Không khớp nguyên văn tại ngày này", tone: "bad" },
  exact: { label: "Khớp nguyên văn", tone: "ok" },
  not_checked: { label: "Không có đoạn trích để so", tone: "muted" },
};

export function CitationCheckView({ context }: { readonly context: QueryContext }) {
  const [documentNumber, setDocumentNumber] = useState("");
  const [article, setArticle] = useState("");
  const [validAt, setValidAt] = useState("");
  const [quotedText, setQuotedText] = useState("");
  const [result, setResult] = useState<CitationCheckResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setFailure(null);
    setResult(null);
    try {
      const response = await checkCitation(context, {
        article: Number(article),
        documentNumber,
        quotedText: quotedText.trim() === "" ? null : quotedText,
        validAt,
      });
      setResult(response);
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Không kiểm chứng được.");
    } finally {
      setBusy(false);
    }
  }

  const data = result?.data ?? null;
  const match = data === null ? null : matchText[data.textMatch.status];

  return (
    <section aria-labelledby="citation-check-heading" className="citation-check">
      <form className="toolbar" onSubmit={onSubmit}>
        <fieldset>
          <legend className="visually-hidden">Kiểm chứng trích dẫn</legend>
          <div className="toolbar-field">
            <label htmlFor="cc-document">Số hiệu văn bản</label>
            <input
              id="cc-document"
              onChange={(event) => {
                setDocumentNumber(event.target.value);
              }}
              placeholder="45/2019/QH14"
              required
              value={documentNumber}
            />
          </div>
          <div className="toolbar-field">
            <label htmlFor="cc-article">Số Điều</label>
            <input
              id="cc-article"
              inputMode="numeric"
              min={1}
              onChange={(event) => {
                setArticle(event.target.value);
              }}
              required
              type="number"
              value={article}
            />
          </div>
          <div className="toolbar-field">
            <label htmlFor="cc-date">Ngày pháp lý</label>
            <input
              id="cc-date"
              onChange={(event) => {
                setValidAt(event.target.value);
              }}
              required
              type="date"
              value={validAt}
            />
          </div>
          <div className="toolbar-field toolbar-field-wide">
            <label htmlFor="cc-text">Đoạn được trích (tuỳ chọn)</label>
            <textarea
              id="cc-text"
              onChange={(event) => {
                setQuotedText(event.target.value);
              }}
              rows={4}
              value={quotedText}
            />
          </div>
          <button disabled={busy} type="submit">
            {busy ? "Đang kiểm…" : "Kiểm chứng"}
          </button>
        </fieldset>
      </form>

      <div aria-live="polite" className="results">
        {failure !== null && (
          <p className="doc-card state-failed" role="alert">
            {failure}
          </p>
        )}
        {data !== null && (
          <article className="doc-card" id="citation-check-heading">
            <h2>
              Điều {String(data.article)} · {data.documentNumber} · ngày{" "}
              <time dateTime={data.validAt}>{data.validAt}</time>
            </h2>
            <dl className="properties">
              <dt>Có trong kho</dt>
              <dd>
                <span className={`chip chip-${data.exists ? "verified" : "unverified"}`}>
                  {data.exists ? "Có" : "Không - kho chưa có văn bản hoặc Điều này"}
                </span>
              </dd>
              <dt>Có hiệu lực tại ngày này</dt>
              <dd>
                <span className={`chip chip-${data.inForceAtDate ? "effective" : "not_effective"}`}>
                  {data.inForceAtDate ? "Có" : "Không"}
                </span>
              </dd>
              <dt>Đoạn trích</dt>
              <dd>
                <span className={`chip chip-match-${match?.tone ?? "muted"}`}>
                  {match?.label ?? data.textMatch.status}
                </span>
                {data.textMatch.similarity !== null && (
                  <span className="hint">
                    {" "}
                    trùng {(data.textMatch.similarity * 100).toFixed(1)}% từ
                  </span>
                )}
              </dd>
              {data.citation !== null && (
                <>
                  <dt>Mức đã kiểm</dt>
                  <dd>
                    <span className={`chip chip-${data.citation.reviewStatus}`}>
                      {data.citation.reviewStatus}
                    </span>
                  </dd>
                </>
              )}
            </dl>
            {data.target !== null && (
              <p>
                <a
                  className="ref-link"
                  href={toSearchString({
                    ...emptyState,
                    datasetReleaseId: context.datasetReleaseId,
                    provisionId: data.target.provisionId,
                    validAt: data.validAt,
                    view: "tra-cuu",
                  })}
                >
                  Mở nguyên văn tại ngày {data.validAt}
                </a>
              </p>
            )}
            <p className="note">
              Kết quả trả lời ba câu tách bạch. Không có câu nào là kết luận pháp lý về vụ việc của
              bạn.
            </p>
          </article>
        )}
      </div>
    </section>
  );
}
