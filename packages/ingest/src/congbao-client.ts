// Reads a congbao.chinhphu.vn detail page. The page carries the metadata and a
// link to the signed PDF; it deliberately carries no legal text, because the
// gazette's legal artifact is the signed file and the page renders it with
// PDF.js at view time (SR-005).

export type CongBaoPageErrorCode =
  | "PDF_LINK_NOT_FOUND"
  | "DOCUMENT_NUMBER_NOT_FOUND"
  | "ISSUE_DATE_NOT_FOUND"
  | "EFFECTIVE_DATE_NOT_STATED";

export class CongBaoPageError extends Error {
  public readonly code: CongBaoPageErrorCode;

  public constructor(code: CongBaoPageErrorCode, message: string) {
    super(message);
    this.name = "CongBaoPageError";
    this.code = code;
  }
}

export interface CongBaoDocumentReference {
  /** Absolute URL of the signed PDF the gazette published. */
  readonly pdfUrl: string;
  /** Gazette issue and date, e.g. "Công báo số 496 ngày 2026-08-29". */
  readonly locator: string;
  readonly documentNumber: string;
  readonly title: string;
  /** Date of signature, ISO. */
  readonly issuedOn: string;
  /** Date the gazette states the document takes effect, ISO. */
  readonly effectiveFrom: string;
}

function plainText(html: string): string {
  return html
    .replaceAll(/<script[\s\S]*?<\/script>/gu, " ")
    .replaceAll(/<style[\s\S]*?<\/style>/gu, " ")
    .replaceAll(/<[^>]+>/gu, " ")
    .replaceAll("&nbsp;", " ")
    .replaceAll(/\s+/gu, " ")
    .normalize("NFC")
    .trim();
}

function isoFromDayMonthYear(value: string): string | null {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u.exec(value.trim());
  if (match === null) {
    return null;
  }
  const [, day, month, year] = match;
  if (day === undefined || month === undefined || year === undefined) {
    return null;
  }
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

export function readCongBaoDetailPage(html: string): CongBaoDocumentReference {
  // The active attachment is the published file for this document; its title
  // attribute names the gazette issue, which is the citation locator.
  const attachment =
    /<a[^>]*data-href="(?<href>[^"]+\.pdf)"[^>]*title="(?<title>[^"]*)"[^>]*class="[^"]*itemtep[^"]*active/u.exec(
      html,
    );
  if (attachment?.groups === undefined) {
    throw new CongBaoPageError(
      "PDF_LINK_NOT_FOUND",
      "trang chi tiết không có link PDF đang hoạt động; cấu trúc trang có thể đã đổi",
    );
  }
  const pdfUrl = attachment.groups["href"];
  const locator = plainText(attachment.groups["title"] ?? "");
  if (pdfUrl === undefined || locator === "") {
    throw new CongBaoPageError(
      "PDF_LINK_NOT_FOUND",
      "link PDF thiếu địa chỉ hoặc thiếu số Công báo",
    );
  }

  const text = plainText(html);
  const numbered =
    /(?<kind>Nghị định|Thông tư|Quyết định|Luật|Nghị quyết|Pháp lệnh|Văn bản hợp nhất)\s+số\s+(?<number>[0-9A-Za-zĐÐ/.-]+)/u.exec(
      text,
    );
  if (numbered?.groups === undefined) {
    throw new CongBaoPageError(
      "DOCUMENT_NUMBER_NOT_FOUND",
      "không đọc được loại và số hiệu văn bản trên trang chi tiết",
    );
  }
  const documentNumber = numbered.groups["number"] ?? "";

  // The two dates are read separately, because they fail for different reasons
  // and a caller deserves to know which. Neither is ever inferred.
  const issuedOn = isoFromDayMonthYear(/Ban hành:\s*([\d/]+)/u.exec(text)?.[1] ?? "");
  const effectiveFrom = isoFromDayMonthYear(/Hiệu lực:\s*([\d/]+)/u.exec(text)?.[1] ?? "");
  if (issuedOn === null) {
    throw new CongBaoPageError(
      "ISSUE_DATE_NOT_FOUND",
      `văn bản ${documentNumber}: trang chi tiết không nêu ngày ban hành`,
    );
  }
  if (effectiveFrom === null) {
    // A consolidated document ("văn bản hợp nhất") has no effective date of its
    // own: it restates other documents, whose dates govern. The gazette leaves
    // the field empty. Refusing is right, but the reason must be accurate, not
    // "the page is missing something".
    throw new CongBaoPageError(
      "EFFECTIVE_DATE_NOT_STATED",
      `văn bản ${documentNumber}: Công báo bỏ trống ngày hiệu lực (thường gặp ở văn bản hợp nhất - hiệu lực thuộc về các văn bản được hợp nhất). Người review phải tự xác định, máy không suy ra`,
    );
  }

  const titleMatch = /<title>(?<title>[^<]*)<\/title>/u.exec(html);
  const title = plainText(titleMatch?.groups?.["title"] ?? "").replace(/\s*-\s*Công báo.*$/u, "");

  return {
    documentNumber,
    effectiveFrom,
    issuedOn,
    locator,
    pdfUrl,
    title: title === "" ? `${numbered.groups["kind"] ?? "Văn bản"} số ${documentNumber}` : title,
  };
}
