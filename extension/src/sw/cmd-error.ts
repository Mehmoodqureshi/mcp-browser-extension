import type { ExecutorErrorCode } from '../../../shared/protocol';

/** A command failure carrying a wire error code. */
export class CmdError extends Error {
  constructor(
    public readonly code: ExecutorErrorCode,
    message: string,
  ) {
    super(message);
  }
}
