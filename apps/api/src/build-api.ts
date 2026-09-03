import {
  LegalQueryError,
  type LegalQueryService,
  type QueryExecutionInput,
} from "@luatvn/application";
import {
  CompareProvisionVersionsRequestSchema,
  CompareProvisionVersionsResponseSchema,
  ErrorResponseSchema,
  GetCatalogRequestSchema,
  GetCatalogResponseSchema,
  GetProvisionAtRequestSchema,
  CheckCitationRequestSchema,
  CheckCitationResponseSchema,
  GetProvisionAtResponseSchema,
  LookupByCitationRequestSchema,
  LookupByCitationResponseSchema,
  SearchProvisionsRequestSchema,
  SearchProvisionsResponseSchema,
  TraceAmendmentsRequestSchema,
  TraceAmendmentsResponseSchema,
} from "@luatvn/contracts";
import Fastify, { LogController, type FastifyRequest } from "fastify";
import {
  hasZodFastifySchemaValidationErrors,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { z } from "zod";

export interface BuildApiOptions {
  readonly legalQueryService: LegalQueryService;
  readonly operationTimeoutMs?: number;
  /**
   * The release this process serves. Needed by the permanent citation URLs,
   * which carry no release of their own: the URL names the law, the server
   * names the snapshot it is answering from.
   */
  readonly datasetReleaseId?: string;
  /**
   * Reads one archived source by its SHA-256, or null when this server holds no
   * copy. A function rather than a map because the archive is the heavy half of
   * the data - fifty times the size of what answering a query needs - and must
   * not be held in memory to be servable (VER-005, ADR-0007 3c).
   */
  readonly readArchivedSource?: (digest: string) => Promise<Uint8Array | null>;
}

const defaultOperationTimeoutMs = 10_000;

function statusCodeForLegalQueryError(error: LegalQueryError): 400 | 404 | 408 | 409 {
  switch (error.code) {
    case "INVALID_INPUT":
      return 400;
    case "VERSION_NOT_FOUND":
      return 404;
    case "REQUEST_ABORTED":
      return 408;
    case "CROSS_PROVISION_COMPARE":
    case "RESULT_LIMIT_EXCEEDED":
    case "UNVERIFIED_RELATION":
    case "UNVERIFIED_VERSION":
      return 409;
  }
}

async function runWithExecution<Value>(
  request: FastifyRequest,
  operationTimeoutMs: number,
  run: (execution: QueryExecutionInput) => Promise<Value>,
): Promise<Value> {
  const operationController = new AbortController();
  const abortOperation = () => operationController.abort();
  const requestSocket = request.raw.socket;
  requestSocket.once("close", abortOperation);
  if (requestSocket.destroyed) {
    operationController.abort();
  }

  const timeout = setTimeout(abortOperation, operationTimeoutMs);
  timeout.unref();
  const deadlineAt = new Date(Date.now() + operationTimeoutMs).toISOString();

  try {
    return await run({ deadlineAt, signal: operationController.signal });
  } finally {
    clearTimeout(timeout);
    requestSocket.off("close", abortOperation);
  }
}

export function buildApi(options: BuildApiOptions) {
  const operationTimeoutMs = options.operationTimeoutMs ?? defaultOperationTimeoutMs;
  if (!Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs <= 0) {
    throw new RangeError("operationTimeoutMs must be a positive safe integer");
  }

  const app = Fastify({
    bodyLimit: 64 * 1_024,
    logController: new LogController({ disableRequestLogging: true }),
    logger: false,
    requestTimeout: 10_000,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.setErrorHandler((error, request, reply) => {
    if (hasZodFastifySchemaValidationErrors(error)) {
      return reply.status(400).send({
        error: {
          code: "INVALID_REQUEST",
          message: "Request does not match the public contract",
          requestId: request.id,
        },
      });
    }

    if (error instanceof LegalQueryError) {
      return reply.status(statusCodeForLegalQueryError(error)).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id,
        },
      });
    }

    return reply.status(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "The request could not be completed",
        requestId: request.id,
      },
    });
  });

  app.get(
    "/health",
    {
      schema: {
        response: {
          200: z.object({ status: z.literal("ok") }).strict(),
        },
      },
    },
    async () => ({ status: "ok" as const }),
  );

  // VER-005 (owner decision 2026-09-03: yes). The archived source is served by
  // its own digest, so a reader can fetch the exact bytes the text was derived
  // from and re-run the derivation themselves. This is what turns "trust me"
  // into "check it yourself"; without it the evidence chain is only checkable
  // by whoever holds the disk.
  app.get(
    "/v1/sources/:digest",
    {
      schema: {
        params: z
          .object({ digest: z.string().regex(/^[0-9a-f]{64}$/u, "digest must be a SHA-256") })
          .strict(),
        // The 200 is raw bytes, not JSON, so it is declared as such: the type
        // provider would otherwise try to serialise a Buffer through a schema.
        response: {
          200: z.instanceof(Buffer),
          404: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const bytes = await options.readArchivedSource?.(request.params.digest);
      if (bytes === undefined || bytes === null) {
        return reply.status(404).send({
          error: {
            code: "SOURCE_NOT_AVAILABLE",
            message: "Máy chủ này không giữ bản sao nguồn có mã băm đó",
            requestId: request.id,
          },
        });
      }
      // Served as a download and never rendered: these are untrusted bytes from
      // an external site and must not execute in the reader's browser. The
      // digest is the URL, so the response can be cached forever.
      return reply
        .header("content-type", "application/octet-stream")
        .header("content-disposition", `attachment; filename="${request.params.digest}"`)
        .header("x-content-type-options", "nosniff")
        .header("cache-control", "public, max-age=31536000, immutable")
        .send(Buffer.from(bytes));
    },
  );

  const citationSegment = /^dieu-(?<article>\d{1,5})@(?<validAt>\d{4}-\d{2}-\d{2})$/u;
  app.get(
    "/c/:documentNumber/:articleAt",
    {
      schema: {
        params: z
          .object({
            articleAt: z.string().min(1).max(64),
            documentNumber: z.string().min(1).max(256),
          })
          .strict(),
        response: {
          200: LookupByCitationResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          408: ErrorResponseSchema,
          409: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const match = citationSegment.exec(request.params.articleAt);
      if (match?.groups === undefined) {
        return reply.status(400).send({
          error: {
            code: "INVALID_REQUEST",
            message: "Địa chỉ phải có dạng /c/<số hiệu>/dieu-<số Điều>@<YYYY-MM-DD>",
            requestId: request.id,
          },
        });
      }
      if (options.datasetReleaseId === undefined) {
        return reply.status(404).send({
          error: {
            code: "NO_SERVED_RELEASE",
            message:
              "Máy chủ này không phục vụ bản phát hành nào, nên không trả lời được địa chỉ trích dẫn",
            requestId: request.id,
          },
        });
      }
      const releaseId = options.datasetReleaseId;
      return runWithExecution(request, operationTimeoutMs, (execution) =>
        options.legalQueryService.lookupByCitation(
          {
            article: Number(match.groups?.["article"]),
            context: {
              datasetReleaseId: releaseId,
              knownAt: new Date().toISOString(),
              // Request ids must be at least 8 characters; "c-req-1" was 7 and
              // the application refused every permanent address with a 400.
              requestId: `citation-${request.id}`,
            },
            documentNumber: request.params.documentNumber,
            validAt: match.groups?.["validAt"] ?? "",
          },
          execution,
        ),
      );
    },
  );

  app.post(
    "/v1/catalog",
    {
      schema: {
        body: GetCatalogRequestSchema,
        response: {
          200: GetCatalogResponseSchema,
          400: ErrorResponseSchema,
          408: ErrorResponseSchema,
          409: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request) =>
      runWithExecution(request, operationTimeoutMs, (execution) =>
        options.legalQueryService.getCatalog(request.body, execution),
      ),
  );

  app.post(
    "/v1/provisions/at",
    {
      schema: {
        body: GetProvisionAtRequestSchema,
        response: {
          200: GetProvisionAtResponseSchema,
          400: ErrorResponseSchema,
          408: ErrorResponseSchema,
          409: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request) =>
      runWithExecution(request, operationTimeoutMs, (execution) =>
        options.legalQueryService.getProvisionAt(request.body, execution),
      ),
  );

  // A citation the way people write one: document number, article, date.
  // Same answer shape as /v1/provisions/at, plus the ways a citation can fail
  // to land: no such document in the corpus, no such article, or two articles
  // with that number.
  app.post(
    "/v1/citations/lookup",
    {
      schema: {
        body: LookupByCitationRequestSchema,
        response: {
          200: LookupByCitationResponseSchema,
          400: ErrorResponseSchema,
          408: ErrorResponseSchema,
          409: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request) =>
      runWithExecution(request, operationTimeoutMs, (execution) =>
        options.legalQueryService.lookupByCitation(request.body, execution),
      ),
  );

  // "Does this quotation say what the law said on that date?" Three answers,
  // kept apart: the article exists, a version was in force, the text matches.
  app.post(
    "/v1/citations/check",
    {
      schema: {
        body: CheckCitationRequestSchema,
        response: {
          200: CheckCitationResponseSchema,
          400: ErrorResponseSchema,
          408: ErrorResponseSchema,
          409: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request) =>
      runWithExecution(request, operationTimeoutMs, (execution) =>
        options.legalQueryService.checkCitation(request.body, execution),
      ),
  );

  // A situation in ordinary words -> the provisions in force on the date that
  // best match it. Lexical baseline; an empty or irrelevant result is a real
  // answer and is reported as such.
  app.post(
    "/v1/search",
    {
      schema: {
        body: SearchProvisionsRequestSchema,
        response: {
          200: SearchProvisionsResponseSchema,
          400: ErrorResponseSchema,
          408: ErrorResponseSchema,
          409: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request) =>
      runWithExecution(request, operationTimeoutMs, (execution) =>
        options.legalQueryService.searchProvisions(request.body, execution),
      ),
  );

  app.post(
    "/v1/provisions/compare",
    {
      schema: {
        body: CompareProvisionVersionsRequestSchema,
        response: {
          200: CompareProvisionVersionsResponseSchema,
          400: ErrorResponseSchema,
          404: ErrorResponseSchema,
          408: ErrorResponseSchema,
          409: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request) =>
      runWithExecution(request, operationTimeoutMs, (execution) =>
        options.legalQueryService.compareProvisionVersions(request.body, execution),
      ),
  );

  app.post(
    "/v1/provisions/amendments",
    {
      schema: {
        body: TraceAmendmentsRequestSchema,
        response: {
          200: TraceAmendmentsResponseSchema,
          400: ErrorResponseSchema,
          408: ErrorResponseSchema,
          409: ErrorResponseSchema,
          500: ErrorResponseSchema,
        },
      },
    },
    async (request) =>
      runWithExecution(request, operationTimeoutMs, (execution) =>
        options.legalQueryService.traceAmendments(request.body, execution),
      ),
  );

  return app;
}
