/** Shared transfer error type for both engines. */
export class TransferError extends Error {
  constructor(code, message, detail = {}) {
    super(message);
    this.name = 'TransferError';
    this.code = code;
    Object.assign(this, detail);
  }
}

/** True when an error means "the other side stopped", not "we broke". */
export function isPeerLossError(error) {
  return error instanceof TransferError && error.code === 'PEER_CLOSED';
}
