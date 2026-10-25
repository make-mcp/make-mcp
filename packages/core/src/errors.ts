export type MakeMcpErrorCode =
  | "FETCH_BLOCKED"
  | "FETCH_FAILED"
  | "FETCH_TOO_LARGE"
  | "SPEC_INVALID"
  | "SOURCE_NOT_FOUND"
  | "INTAKE_INCOMPLETE"
  | "PATH_OUTSIDE_WORKSPACE"
  | "ROBOTS_DISALLOWED"
  | "SESSION_NOT_FOUND"
  | "PUBLISH_BLOCKED"
  | "OUTPUT_NOT_EMPTY";

export class MakeMcpError extends Error {
  readonly code: MakeMcpErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: MakeMcpErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "MakeMcpError";
    this.code = code;
    this.details = details;
  }
}

export function isMakeMcpError(err: unknown, code?: MakeMcpErrorCode): err is MakeMcpError {
  return err instanceof MakeMcpError && (code === undefined || err.code === code);
}
