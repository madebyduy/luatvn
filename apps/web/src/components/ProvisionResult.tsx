import type React from "react";

import type { ProvisionAtResponse } from "../api.js";
import { emptyState, toSearchString } from "../url-state.js";

const unknownReasonText: Record<string, string> = {
  MATCH_ONLY_UNVERIFIED: "Có bản ghi khớp thời điểm nhưng chưa được người kiểm tra xác nhận.",
  NO_MATCHING_VERSION: "Không có phiên bản nào của điều khoản này khớp thời điểm được hỏi.",
};

function CandidateList({ ids }: { readonly ids: readonly string[] }) {
  if (ids.length === 0) {
    return null;
  }
  return (
    <>
      <p>Các phiên bản ứng viên:</p>
      <ul className="candidates">
        {ids.map((id) => (
          <li key={id}>
            <code>{id}</code>
          </li>
        ))}
      </ul>
    </>
  );
}

// The three legal states are rendered as three visibly and semantically
// distinct blocks. "unknown" and "conflict" are answers in their own right and
// are never dressed up as a resolved provision.
export function ProvisionResult({ response }: { readonly response: ProvisionAtResponse }) {
  const { data } = response;

  if (data.status === "unknown") {
    return (
      <article aria-labelledby="result-heading" className="doc-card state-unknown">
        <p className="state-badge">Chưa xác định</p>
        <h2 id="result-heading">Không có câu trả lời chắc chắn</h2>
        <p>{unknownReasonText[data.reason] ?? data.reason}</p>
        <CandidateList ids={data.candidateVersionIds} />
        <p className="note">
          Hệ thống không chọn phiên bản gần nhất để lấp chỗ trống. Thiếu bằng chứng thì trả về chưa
          xác định.
        </p>
      </article>
    );
  }

  if (data.status === "conflict") {
    return (
      <article aria-labelledby="result-heading" className="doc-card state-conflict">
        <p className="state-badge">Xung đột dữ liệu</p>
        <h2 id="result-heading">Nhiều phiên bản đã kiểm chứng cùng khớp</h2>
        <p>
          Tại thời điểm được hỏi có nhiều hơn một phiên bản hợp lệ. Đây là mâu thuẫn dữ liệu cần
          người xử lý, không phải kết quả tra cứu.
        </p>
        <CandidateList ids={data.candidateVersionIds} />
      </article>
    );
  }

  return (
    <article aria-labelledby="result-heading" className="doc-card state-resolved">
      <header className="doc-card-header">
        <p className="state-badge">Đã xác định</p>
        <h2 id="result-heading">{data.provision.heading ?? data.provision.provisionId}</h2>
        <p className="doc-card-sub">
          {data.citation.documentNumber} · có hiệu lực từ{" "}
          <time dateTime={data.citation.validAt}>{data.citation.validAt}</time>
        </p>
      </header>
      <p className="untrusted-note">
        Nội dung dưới đây là dữ liệu pháp luật lấy nguyên văn từ nguồn, hiển thị dạng văn bản thuần.
        Đây không phải tư vấn pháp lý.
      </p>
      <div className="legal-text">
        {renderLinesWithReferences(data.provision.legalText, data.references, {
          datasetReleaseId: data.citation.datasetReleaseId,
          validAt: data.citation.validAt,
        })}
      </div>
    </article>
  );
}

type ReferenceOfResponse = Extract<
  ProvisionAtResponse["data"],
  { status: "resolved" }
>["references"][number];

const unresolvedReasonText: Record<string, string> = {
  AMBIGUOUS: "Nhiều điều khoản cùng khớp; chưa xác định được đích",
  NOT_IN_CORPUS: "Văn bản được dẫn chưa có trong kho",
  NOT_IN_FORCE_AT_DATE: "Điều được dẫn không có phiên bản hiệu lực tại ngày này",
  UNSUPPORTED: "Chưa hỗ trợ dẫn tới loại tham chiếu này",
};

// Every recognised cross-reference becomes a link to the referenced article as
// it stood on the same legal date - the text reads like a web page instead of a
// scan. A reference the corpus cannot satisfy stays plain text with the reason
// on hover; it is never linked to a guess. References that wrap across a line
// break are left as text.
function renderLinesWithReferences(
  legalText: string,
  references: readonly ReferenceOfResponse[],
  context: { readonly datasetReleaseId: string; readonly validAt: string },
) {
  const lines = legalText.split("\n");
  let offset = 0;
  return lines.map((line, index) => {
    const lineStart = offset;
    const lineEnd = offset + line.length;
    offset = lineEnd + 1;
    const inLine = references
      .filter((reference) => reference.start >= lineStart && reference.end <= lineEnd)
      .toSorted((left, right) => left.start - right.start);
    if (inLine.length === 0) {
      return <p key={`${String(index)}-${line.slice(0, 12)}`}>{line}</p>;
    }
    const parts: React.ReactNode[] = [];
    let cursor = lineStart;
    for (const reference of inLine) {
      if (reference.start > cursor) {
        parts.push(legalText.slice(cursor, reference.start));
      }
      const label = legalText.slice(reference.start, reference.end);
      if (reference.target !== null) {
        parts.push(
          <a
            className="ref-link"
            href={toSearchString({
              ...emptyState,
              datasetReleaseId: context.datasetReleaseId,
              provisionId: reference.target.provisionId,
              validAt: context.validAt,
              view: "tra-cuu",
            })}
            key={`${String(reference.start)}-${reference.target.provisionVersionId}`}
            title={`Mở ${label} tại ngày ${context.validAt}`}
          >
            {label}
          </a>,
        );
      } else {
        parts.push(
          <span
            className="ref-unresolved"
            key={`${String(reference.start)}-unresolved`}
            title={unresolvedReasonText[reference.reason ?? ""] ?? "Chưa giải được tham chiếu"}
          >
            {label}
          </span>,
        );
      }
      cursor = reference.end;
    }
    if (cursor < lineEnd) {
      parts.push(legalText.slice(cursor, lineEnd));
    }
    return <p key={`${String(index)}-${line.slice(0, 12)}`}>{parts}</p>;
  });
}
