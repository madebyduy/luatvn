import type { z } from "zod";

export interface DecodeIssue {
  readonly path: string;
  readonly message: string;
}

export type DecodeResult<Value> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly issues: readonly [DecodeIssue, ...DecodeIssue[]] };

export function runDecoder<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): DecodeResult<z.output<Schema>> {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }

  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.map(String).join("."),
    message: issue.message,
  }));
  const [first, ...rest] = issues;
  if (first === undefined) {
    return {
      ok: false,
      issues: [{ path: "", message: "Decoding failed without a reported issue" }],
    };
  }
  return { ok: false, issues: [first, ...rest] };
}
