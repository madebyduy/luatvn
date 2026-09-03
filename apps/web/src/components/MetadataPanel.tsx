import type { ProvisionAtResponse } from "../api.js";

type Citation = Extract<ProvisionAtResponse["data"], { status: "resolved" }>["citation"];

const validityLabels: Record<string, string> = {
  effective: "Còn hiệu lực tại ngày hỏi",
  not_effective: "Chưa/không còn hiệu lực tại ngày hỏi",
  unknown: "Chưa xác định",
};

// The level of checking is shown, never hidden: a reader acts on it. Names,
// hashes and logs stay behind a click; this one word does not.
const reviewLabels: Record<string, string> = {
  machine_checked: "Đã đối soát, chưa người duyệt",
  under_review: "Đang chờ kiểm chứng",
  unverified: "Chưa kiểm chứng",
  verified: "Người đã xác minh",
};

// The properties table Vietnamese legal databases put beside every document.
// Everything here comes from the citation the API returned, so nothing is
// inferred or filled in by the interface.
export function MetadataPanel({ citation }: { readonly citation: Citation }) {
  return (
    <section aria-labelledby="metadata-heading" className="side-panel">
      <h2 className="panel-title" id="metadata-heading">
        Thuộc tính văn bản
      </h2>
      <dl className="properties">
        <dt>Số hiệu</dt>
        <dd>{citation.documentNumber}</dd>

        <dt>Ngày pháp lý được hỏi</dt>
        <dd>
          <time dateTime={citation.validAt}>{citation.validAt}</time>
        </dd>

        <dt>Tình trạng hiệu lực</dt>
        <dd>
          <span className={`chip chip-${citation.validityStatus}`}>
            {validityLabels[citation.validityStatus] ?? citation.validityStatus}
          </span>
        </dd>

        <dt>Trạng thái kiểm tra</dt>
        <dd>
          <span className={`chip chip-${citation.reviewStatus}`}>
            {reviewLabels[citation.reviewStatus] ?? citation.reviewStatus}
          </span>
        </dd>

        <dt>Mã điều khoản</dt>
        <dd>
          <code>{citation.provisionId}</code>
        </dd>

        <dt>Mã phiên bản</dt>
        <dd>
          <code>{citation.provisionVersionId}</code>
        </dd>

        <dt>Bản phát hành</dt>
        <dd>
          <code>{citation.datasetReleaseId}</code>
        </dd>
      </dl>
    </section>
  );
}

export function EvidencePanel({ citation }: { readonly citation: Citation }) {
  return (
    <section aria-labelledby="evidence-heading" className="side-panel">
      <h2 className="panel-title" id="evidence-heading">
        Bằng chứng nguồn
      </h2>
      <dl className="properties">
        <dt>Nguồn chính thức</dt>
        <dd>
          <a href={citation.sourceUrl} rel="noreferrer noopener nofollow" target="_blank">
            {citation.sourceUrl}
            <span className="visually-hidden"> (mở tab mới)</span>
          </a>
        </dd>

        <dt>SHA-256 của nguồn</dt>
        <dd>
          <code className="hash">{citation.sourceSha256}</code>
        </dd>

        <dt>Thu thập lúc</dt>
        <dd>
          <time dateTime={citation.retrievedAt}>{citation.retrievedAt}</time>
        </dd>

        <dt>Hệ thống kiểm tra lúc</dt>
        <dd>
          <time dateTime={citation.checkedAt}>{citation.checkedAt}</time>
        </dd>

        <dt>Vị trí trong nguồn</dt>
        <dd>{citation.locator ?? "không ghi"}</dd>
      </dl>
      <p className="hint">
        Đối chiếu được: tải nguồn theo địa chỉ trên, băm SHA-256 và so với giá trị ở đây.
      </p>
    </section>
  );
}
