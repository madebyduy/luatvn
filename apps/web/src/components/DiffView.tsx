import type { CompareResponse } from "../api.js";

const operationLabels: Record<string, string> = {
  added: "Thêm mới",
  removed: "Bỏ đi",
  unchanged: "Giữ nguyên",
};

function CitationLine({
  citation,
  role,
}: {
  readonly citation: CompareResponse["data"]["fromCitation"];
  readonly role: string;
}) {
  return (
    <p className="version-line">
      <strong>{role}:</strong> <code>{citation.provisionVersionId}</code> — có hiệu lực từ{" "}
      <time dateTime={citation.validAt}>{citation.validAt}</time>, theo {citation.documentNumber}
    </p>
  );
}

// Shows the two versions side by side as the source wrote them. Unchanged lines
// stay visible so a reader can see what was left alone, and nothing is
// summarised or reworded.
export function DiffView({ response }: { readonly response: CompareResponse }) {
  const { data } = response;
  const changed = data.chunks.filter((chunk) => chunk.operation !== "unchanged").length;

  return (
    <article aria-labelledby="diff-heading" className="doc-card state-resolved">
      <header className="doc-card-header">
        <p className="state-badge">So sánh</p>
        <h2 id="diff-heading">Thay đổi giữa hai phiên bản</h2>
      </header>
      <CitationLine citation={data.fromCitation} role="Phiên bản trước" />
      <CitationLine citation={data.toCitation} role="Phiên bản sau" />
      <p className="note">
        {changed === 0
          ? "Hai phiên bản có nguyên văn giống hệt nhau."
          : `Có ${String(changed)} đoạn khác nhau. Nguyên văn giữ đúng như nguồn, không tóm tắt.`}
      </p>

      <section aria-labelledby="diff-body-heading">
        <h3 className="panel-title" id="diff-body-heading">
          Đối chiếu nguyên văn
        </h3>
        <ol className="diff">
          {data.chunks.map((chunk, index) => (
            <li
              className={`diff-chunk diff-${chunk.operation}`}
              key={`${chunk.operation}-${String(index)}`}
            >
              <span className="diff-label">
                {operationLabels[chunk.operation] ?? chunk.operation}
              </span>
              <div className="legal-text">
                {chunk.lines.map((line, lineIndex) => (
                  <p key={`${String(index)}-${String(lineIndex)}`}>{line}</p>
                ))}
              </div>
            </li>
          ))}
        </ol>
      </section>
    </article>
  );
}
