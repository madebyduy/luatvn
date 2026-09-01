import type { ProvisionAtResponse } from "../api.js";

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
        {data.provision.legalText.split("\n").map((line, index) => (
          <p key={`${String(index)}-${line.slice(0, 12)}`}>{line}</p>
        ))}
      </div>
    </article>
  );
}
