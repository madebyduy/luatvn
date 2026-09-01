import {
  LegalQueryError,
  type LegalQueryService,
  type QueryExecutionInput,
} from "@luatvn/application";
import {
  CompareProvisionVersionsRequestSchema,
  CompareProvisionVersionsResponseSchema,
  ErrorResponseSchema,
  GetProvisionAtRequestSchema,
  GetProvisionAtResponseSchema,
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
