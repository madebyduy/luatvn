import type { AmendmentsResponse } from "../api.js";

const relationLabels: Record<string, string> = {
  amends: "sửa đổi, bổ sung",
  corrects: "đính chính",
  repeals: "bãi bỏ",
  replaces: "thay thế",
};

// Lists the amendment relations that touch this provision, each with the source
// it came from. Only relations a human marked verified reach this screen.
export function TraceView({
  provisionId,
  response,
}: {
  readonly provisionId: string;
  readonly response: AmendmentsResponse;
}) {
  const relations = response.data.relations;

  if (relations.length === 0) {
    return (
      <article aria-labelledby="trace-heading" className="doc-card state-unknown">
        <p className="state-badge">Chưa có quan hệ</p>
        <h2 id="trace-heading">Không có quan hệ sửa đổi đã kiểm chứng</h2>
        <p>
          Bản phát hành này chưa có quan hệ sửa đổi nào đã được người kiểm chứng cho điều khoản{" "}
          <code>{provisionId}</code>. Điều đó không có nghĩa là điều khoản chưa từng bị sửa — chỉ có
          nghĩa là dữ liệu đã kiểm chứng chưa ghi nhận.
        </p>
      </article>
    );
  }

  return (
    <article className="state state-resolved" aria-labelledby="trace-heading">
      <p className="state-badge">Lược sử</p>
      <h2 id="trace-heading">{relations.length} quan hệ sửa đổi đã kiểm chứng</h2>
      <ol className="trace">
        {relations.map((relation) => {
          const evidence = relation.evidence[0];
          const isTarget = relation.targetProvisionId === provisionId;
          return (
            <li className="trace-item" key={relation.amendmentId}>
              <p className="trace-headline">
                <strong>
                  {isTarget ? "Bị " : "Đi "}
                  {relationLabels[relation.relationType] ?? relation.relationType}
                </strong>{" "}
                từ ngày <time dateTime={relation.effectiveFrom}>{relation.effectiveFrom}</time>
              </p>
              <dl className="properties">
                <dt>Điều khoản nguồn</dt>
                <dd>
                  <code>{relation.sourceProvisionId}</code>
                </dd>
                <dt>Điều khoản bị tác động</dt>
                <dd>
                  <code>{relation.targetProvisionId}</code>
                </dd>
                <dt>Trạng thái kiểm tra</dt>
                <dd>{relation.reviewStatus}</dd>
                {evidence !== undefined && (
                  <>
                    <dt>Nguồn chính thức</dt>
                    <dd>
                      <a
                        href={evidence.officialSourceUrl}
                        rel="noreferrer noopener nofollow"
                        target="_blank"
                      >
                        {evidence.officialSourceUrl}
                        <span className="visually-hidden"> (mở tab mới)</span>
                      </a>
                    </dd>
                    <dt>SHA-256 của nguồn</dt>
                    <dd>
                      <code>{evidence.sourceSha256}</code>
                    </dd>
                  </>
                )}
              </dl>
            </li>
          );
        })}
      </ol>
    </article>
  );
}
