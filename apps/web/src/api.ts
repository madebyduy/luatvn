import {
  CompareProvisionVersionsResponseSchema,
  ErrorResponseSchema,
  GetCatalogResponseSchema,
  GetProvisionAtResponseSchema,
  TraceAmendmentsResponseSchema,
  type CompareProvisionVersionsResponse,
  type GetCatalogResponse,
  type GetProvisionAtResponse,
  type TraceAmendmentsResponse,
} from "@luatvn/contracts";

export type ProvisionAtResponse = GetProvisionAtResponse;
export type CatalogResponse = GetCatalogResponse;
export type CompareResponse = CompareProvisionVersionsResponse;
export type AmendmentsResponse = TraceAmendmentsResponse;
export type CatalogDocument = CatalogResponse["data"]["documents"][number];
export type CatalogProvision = CatalogDocument["provisions"][number];

export type ApiFailureCode =
  "NETWORK_UNAVAILABLE" | "REQUEST_TIMED_OUT" | "CONTRACT_MISMATCH" | "SERVICE_ERROR";

export class ApiError extends Error {
  public constructor(
    public readonly code: ApiFailureCode,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface QueryContext {
  readonly datasetReleaseId: string;
  readonly knownAt: string;
}

export interface ReadyState {
  readonly datasetReleaseId: string;
}

const requestTimeoutMs = 15_000;

function newRequestId(): string {
  return `web-${globalThis.crypto.randomUUID()}`;
}

function contextBody(context: QueryContext) {
  return {
    datasetReleaseId: context.datasetReleaseId,
    knownAt: context.knownAt,
    requestId: newRequestId(),
  };
}

async function postJson(path: string, body: unknown): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
      method: "POST",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new ApiError("REQUEST_TIMED_OUT", "Máy chủ không phản hồi kịp thời hạn.");
    }
    throw new ApiError("NETWORK_UNAVAILABLE", "Không kết nối được tới máy chủ dữ liệu.");
  }

  const payload: unknown = await response.json().catch(() => null);
  if (response.ok) {
    return payload;
  }

  const failure = ErrorResponseSchema.safeParse(payload);
  throw new ApiError(
    "SERVICE_ERROR",
    failure.success
      ? `${failure.data.error.code}: ${failure.data.error.message}`
      : `Máy chủ trả lỗi ${String(response.status)}.`,
  );
}

// Every response is parsed with the published contract schema, so the UI cannot
// drift away from the API it consumes: a shape change fails loudly here instead
// of rendering something half-defined.
interface ResponseSchema<Value> {
  readonly safeParse: (input: unknown) => { success: true; data: Value } | { success: false };
}

async function postParsed<Value>(
  path: string,
  body: unknown,
  schema: ResponseSchema<Value>,
): Promise<Value> {
  const payload = await postJson(path, body);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError("CONTRACT_MISMATCH", "Phản hồi của máy chủ không khớp hợp đồng công khai.");
  }
  return parsed.data;
}

export function fetchCatalog(context: QueryContext): Promise<CatalogResponse> {
  return postParsed("/v1/catalog", { context: contextBody(context) }, GetCatalogResponseSchema);
}

export function fetchProvisionAt(
  context: QueryContext,
  query: { readonly provisionId: string; readonly validAt: string },
): Promise<ProvisionAtResponse> {
  return postParsed(
    "/v1/provisions/at",
    { context: contextBody(context), provisionId: query.provisionId, validAt: query.validAt },
    GetProvisionAtResponseSchema,
  );
}

export function fetchComparison(
  context: QueryContext,
  query: { readonly fromVersionId: string; readonly toVersionId: string },
): Promise<CompareResponse> {
  return postParsed(
    "/v1/provisions/compare",
    {
      context: contextBody(context),
      fromVersionId: query.fromVersionId,
      toVersionId: query.toVersionId,
    },
    CompareProvisionVersionsResponseSchema,
  );
}

export function fetchAmendments(
  context: QueryContext,
  query: { readonly provisionId: string; readonly maxDepth: 1 | 2 },
): Promise<AmendmentsResponse> {
  return postParsed(
    "/v1/provisions/amendments",
    { context: contextBody(context), maxDepth: query.maxDepth, provisionId: query.provisionId },
    TraceAmendmentsResponseSchema,
  );
}

export async function fetchReadyState(): Promise<ReadyState | null> {
  try {
    const response = await fetch("/ready", { signal: AbortSignal.timeout(requestTimeoutMs) });
    if (!response.ok) {
      return null;
    }
    const payload: unknown = await response.json();
    if (
      typeof payload === "object" &&
      payload !== null &&
      "datasetReleaseId" in payload &&
      typeof payload.datasetReleaseId === "string"
    ) {
      return { datasetReleaseId: payload.datasetReleaseId };
    }
    return null;
  } catch {
    return null;
  }
}
