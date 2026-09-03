import { useState, type FormEvent } from "react";

import { ApiError, searchProvisions, type QueryContext, type SearchResponse } from "../api.js";
import { emptyState, toSearchString } from "../url-state.js";

// The front door for people who do not know article numbers: describe the
// situation, get the provisions in force today that match, each with its trust
// tier and a link to the full text on that date. No sentence here is written
// by a machine about the law - only the law's own words, ranked. When the
// corpus has nothing, that is said in so many words.

const reviewLabels: Record<string, string> = {
  machine_checked: "Đã đối soát, chưa người duyệt",
  under_review: "Đang chờ kiểm chứng",
  unverified: "Chưa kiểm chứng",
  verified: "Người đã xác minh",
};

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function AskView({
  context,
  initialQuery,
  onAsked,
}: {
  readonly context: QueryContext;
  readonly initialQuery: string;
  readonly onAsked: (query: string) => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [validAt, setValidAt] = useState(today());
  const [result, setResult] = useState<SearchResponse | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = query.trim();
    if (trimmed === "") return;
    setBusy(true);
    setFailure(null);
    setResult(null);
    onAsked(trimmed);
    try {
      setResult(await searchProvisions(context, { query: trimmed, validAt }));
    } catch (error) {
      setFailure(error instanceof ApiError ? error.message : "Không tìm được.");
    } finally {
      setBusy(false);
    }
  }

  const data = result?.data ?? null;
  const empty =
    data !== null && (data.corpusEmpty || data.nothingRelevant || data.results.length === 0);

  return (
    <section aria-label="Hỏi bằng tiếng thường" className="ask">
      <form className="ask-form" onSubmit={onSubmit}>
        <label className="ask-label" htmlFor="ask-query">
          Kể tình huống của bạn bằng tiếng thường
        </label>
        <div className="ask-row">
          <input
            autoComplete="off"
            id="ask-query"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            placeholder="ví dụ: công ty nợ lương tôi 2 tháng"
            required
            value={query}
          />
          <button disabled={busy} type="submit">
            {busy ? "Đang tìm…" : "Tìm điều luật"}
          </button>
        </div>
        <div className="ask-row ask-row-secondary">
          <label htmlFor="ask-date">Tại ngày</label>
          <input
            id="ask-date"
            onChange={(event) => {
              setValidAt(event.target.value);
            }}
            type="date"
            value={validAt}
          />
          <span className="hint">Mặc định là hôm nay. Đổi ngày nếu sự việc xảy ra trước đó.</span>
        </div>
      </form>

      <div aria-live="polite" className="results">
        {failure !== null && (
          <p className="doc-card state-failed" role="alert">
            {failure}
          </p>
        )}
        {data !== null && empty && (
          <article className="doc-card state-unknown">
            <p className="state-badge">Chưa có</p>
            <h2>
              {data.corpusEmpty
                ? "Kho chưa có văn bản nào có hiệu lực tại ngày này"
                : "Kho chưa có điều luật nào khớp với mô tả này"}
            </h2>
            <p className="note">
              Hệ thống không đoán và không tự viết câu trả lời. Thử diễn đạt bằng từ ngữ hay dùng
              trong văn bản luật (ví dụ "trả lương", "kỳ hạn"), hoặc chọn ngày khác.
            </p>
          </article>
        )}
        {data !== null && !empty && (
          <ol className="ask-results">
            {data.results.map((hit) => (
              <li className="doc-card ask-hit" key={hit.provisionVersionId}>
                <h2 className="ask-hit-heading">
                  <a
                    className="ref-link"
                    href={toSearchString({
                      ...emptyState,
                      datasetReleaseId: context.datasetReleaseId,
                      provisionId: hit.provisionId,
                      validAt: data.validAt,
                      view: "tra-cuu",
                    })}
                  >
                    {hit.heading ?? hit.provisionId}
                  </a>
                </h2>
                <p className="doc-card-sub">
                  {hit.documentNumber} · hiệu lực từ{" "}
                  <time dateTime={hit.validFrom}>{hit.validFrom}</time>
                  {hit.validTo === null ? "" : ` đến trước ${hit.validTo}`} ·{" "}
                  <span className={`chip chip-${hit.reviewStatus}`}>
                    {reviewLabels[hit.reviewStatus] ?? hit.reviewStatus}
                  </span>
                </p>
                <p className="ask-snippet">{hit.snippet}</p>
              </li>
            ))}
          </ol>
        )}
        {data !== null && (
          <p className="note">
            Tìm theo từ trong nguyên văn, tại ngày {data.validAt}. Đây là dữ liệu tra cứu, không
            phải tư vấn pháp lý.
          </p>
        )}
      </div>
    </section>
  );
}
