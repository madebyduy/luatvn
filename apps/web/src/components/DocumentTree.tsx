import type { CatalogDocument } from "../api.js";

interface DocumentTreeProps {
  readonly documents: readonly CatalogDocument[];
  readonly note: string | null;
  readonly onSelect: (provisionId: string) => void;
  readonly selectedProvisionId: string;
}

// The document tree is how a legal database is normally navigated: documents
// grouped by their number, each opening into its articles. Entries are links so
// keyboard and screen-reader users move through them the same way as everyone.
export function DocumentTree({
  documents,
  note,
  onSelect,
  selectedProvisionId,
}: DocumentTreeProps) {
  return (
    <nav aria-labelledby="tree-heading" className="doc-tree">
      <h2 className="panel-title" id="tree-heading">
        Danh mục văn bản
      </h2>
      {note !== null && <p className="hint">{note}</p>}
      {documents.map((document) => (
        <section className="doc-tree-group" key={document.documentId}>
          <h3 className="doc-tree-number">{document.documentNumber}</h3>
          <ul>
            {document.provisions.map((provision) => (
              <li key={provision.provisionId}>
                <a
                  aria-current={provision.provisionId === selectedProvisionId ? "true" : undefined}
                  href={`?provision=${encodeURIComponent(provision.provisionId)}`}
                  onClick={(event) => {
                    event.preventDefault();
                    onSelect(provision.provisionId);
                  }}
                >
                  <span className="doc-tree-label">
                    {provision.heading ?? provision.provisionId}
                  </span>
                  <span className="doc-tree-count">{provision.versions.length} phiên bản</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}
