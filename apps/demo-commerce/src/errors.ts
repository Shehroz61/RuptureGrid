// =====================================================================
// Demo Commerce — domain errors and stable HTTP mapping
// =====================================================================
// Expected domain conflicts are differentiated from unexpected
// infrastructure failures. Messages never contain secrets, SQL, stack
// traces, or connection strings. NO RuptureGrid truth vocabulary
// exists here — these are commerce transport/business conditions only.

/** Base class for domain errors with a stable machine-readable code. */
export class CommerceDomainError extends Error {
  /** Stable error code surfaced in HTTP responses. */
  public readonly code: string;
  /** The HTTP status this domain condition maps to. */
  public readonly status: number;

  public constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'CommerceDomainError';
    this.code = code;
    this.status = status;
  }
}

/** Missing/malformed transport metadata (header or body shape). */
export class TransportError extends CommerceDomainError {
  public constructor(message: string) {
    super('TRANSPORT_INVALID', 400, message);
    this.name = 'TransportError';
  }
}

/** Checkout not authentic: missing/invalid Commerce signature. */
export class CheckoutAuthenticationError extends CommerceDomainError {
  public constructor(message: string) {
    super('CHECKOUT_AUTHENTICATION_FAILED', 401, message);
    this.name = 'CheckoutAuthenticationError';
  }
}

/** Missing or wrong bearer credential on a protected route. */
export class UnauthorizedError extends CommerceDomainError {
  public constructor(message: string) {
    super('UNAUTHORIZED', 401, message);
    this.name = 'UnauthorizedError';
  }
}

/**
 * The checkout payload violates the target's declared business
 * contract (missing/mistyped/extra fields, malformed money string).
 * Stable 400; the bounded message never contains request values.
 */
export class PayloadInvalidError extends CommerceDomainError {
  public constructor(message: string) {
    super('PAYLOAD_INVALID', 400, message);
    this.name = 'PayloadInvalidError';
  }
}

/** The requested processing mode does not exist. */
export class InvalidModeError extends CommerceDomainError {
  public constructor(message: string) {
    super('MODE_INVALID', 400, message);
    this.name = 'InvalidModeError';
  }
}

/**
 * The target's definitive contract rejection for the controlled
 * PRE_MUTATION_REJECTION fault — thrown after ALL validation, BEFORE
 * any persistence. Under the conservative GENERIC_HTTP contract this
 * is classified by the PLATFORM, never promised no-effect here (the
 * target's own claim would be metadata, not truth).
 */
export class ControlledFaultRejectionError extends CommerceDomainError {
  public constructor(message: string) {
    super('CONTROLLED_FAULT_REJECTION', 409, message);
    this.name = 'ControlledFaultRejectionError';
  }
}
