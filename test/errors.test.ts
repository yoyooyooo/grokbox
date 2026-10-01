import { describe, expect, test } from "bun:test";
import { CliError, EXIT_CODES, httpStatusToError } from "../src/errors.ts";

function errorEnvelope(error: CliError) {
  return {
    code: error.code,
    exitCode: error.exitCode,
    message: error.message,
    retryable: error.retryable,
    httpStatus: error.httpStatus,
    failureCode: error.failureCode,
  };
}

describe("EXIT_CODES contract", () => {
  test("gateway error codes keep their documented exit codes", () => {
    expect(EXIT_CODES.gateway_bad_request).toBe(10);
    expect(EXIT_CODES.gateway_unauthorized).toBe(11);
    expect(EXIT_CODES.gateway_forbidden).toBe(12);
    expect(EXIT_CODES.gateway_not_found).toBe(13);
    expect(EXIT_CODES.gateway_conflict).toBe(14);
    expect(EXIT_CODES.gateway_internal).toBe(15);
  });
});

describe("httpStatusToError mapped statuses", () => {
  test("400 -> gateway_bad_request (exit 10), with its own message", () => {
    expect(errorEnvelope(httpStatusToError(400, undefined, "Gateway request failed."))).toEqual({
      code: "gateway_bad_request",
      exitCode: 10,
      message: "Gateway rejected the request body.",
      retryable: false,
      httpStatus: 400,
      failureCode: undefined,
    });
  });

  test("409 -> gateway_conflict (exit 14), the last explicitly mapped status", () => {
    const error = httpStatusToError(409, "conflict", "Gateway request failed.");
    expect(error.code).toBe("gateway_conflict");
    expect(error.exitCode).toBe(14);
    expect(error.httpStatus).toBe(409);
    expect(error.failureCode).toBe("conflict");
  });
});

describe("httpStatusToError unmapped statuses", () => {
  test("unmapped 4xx (422) -> gateway_bad_request (exit 10), not gateway_internal", () => {
    expect(errorEnvelope(httpStatusToError(422, "validation_failed", "Gateway request failed."))).toEqual({
      code: "gateway_bad_request",
      exitCode: 10,
      message: "Gateway request failed.",
      retryable: false,
      httpStatus: 422,
      failureCode: "validation_failed",
    });
  });

  test("3xx redirect (302) -> gateway_bad_request (exit 10), not gateway_internal", () => {
    const error = httpStatusToError(302, "redirect_refused", "Gateway request failed.");
    expect(error.code).toBe("gateway_bad_request");
    expect(error.exitCode).toBe(10);
    expect(error.httpStatus).toBe(302);
    expect(error.retryable).toBe(false);
    expect(error.failureCode).toBe("redirect_refused");
  });

  test("5xx (500) -> gateway_internal (exit 15), retryable", () => {
    expect(errorEnvelope(httpStatusToError(500, undefined, "Gateway request failed."))).toEqual({
      code: "gateway_internal",
      exitCode: 15,
      message: "Gateway request failed.",
      retryable: true,
      httpStatus: 500,
      failureCode: undefined,
    });
  });

  test("the 500 boundary splits 4xx from 5xx", () => {
    expect(httpStatusToError(499, undefined, "x").code).toBe("gateway_bad_request");
    expect(httpStatusToError(500, undefined, "x").code).toBe("gateway_internal");
  });
});
