// =====================================================================
// Demo Fintech — domain errors and stable HTTP mapping
// =====================================================================
// Expected domain conflicts are differentiated from unexpected
// infrastructure failures (Phase 2 §42, §95). Messages never contain
// secrets, SQL, stack traces, or connection strings.

/** Base class for domain errors with a stable machine-readable code. */
export class DemoDomainError extends Error {
  /** Stable error code surfaced in HTTP responses. */
  public readonly code: string;
  /** The HTTP status this domain condition maps to (§42). */
  public readonly status: number;

  public constructor(code: string, status: number, message: string) {
    super(message);
    this.name = 'DemoDomainError';
    this.code = code;
    this.status = status;
  }
}

/** Missing/malformed transport metadata (header or body shape). */
export class TransportError extends DemoDomainError {
  public constructor(message: string) {
    super('TRANSPORT_INVALID', 400, message);
    this.name = 'TransportError';
  }
}

/** Webhook not authentic for the provider: missing/invalid signature. */
export class ProviderAuthenticationError extends DemoDomainError {
  public constructor(message: string) {
    super('PROVIDER_AUTHENTICATION_FAILED', 401, message);
    this.name = 'ProviderAuthenticationError';
  }
}

/** A referenced business entity does not exist (event/payment/wallet). */
export class NotFoundError extends DemoDomainError {
  public constructor(message: string) {
    super('NOT_FOUND', 404, message);
    this.name = 'NotFoundError';
  }
}

/** Payload contradicts the stored authoritative business state. */
export class BusinessMismatchError extends DemoDomainError {
  public constructor(message: string) {
    super('BUSINESS_MISMATCH', 409, message);
    this.name = 'BusinessMismatchError';
  }
}

/** Two physical requests claim one deliveryAttemptId — malformed contract. */
export class DuplicateDeliveryIdentityError extends DemoDomainError {
  public constructor(message: string) {
    super('DUPLICATE_DELIVERY_ATTEMPT_ID', 409, message);
    this.name = 'DuplicateDeliveryIdentityError';
  }
}

/** Missing or wrong bearer credential on a protected route. */
export class UnauthorizedError extends DemoDomainError {
  public constructor(message: string) {
    super('UNAUTHORIZED', 401, message);
    this.name = 'UnauthorizedError';
  }
}

/** The requested demo mode does not exist. */
export class InvalidModeError extends DemoDomainError {
  public constructor(message: string) {
    super('MODE_INVALID', 400, message);
    this.name = 'InvalidModeError';
  }
}

/**
 * Phase 9 (docs/controlled-faults.md §4.1): the target's definitive
 * contract rejection for the controlled PRE_MUTATION_REJECTION fault —
 * thrown after ALL validation, BEFORE any persistence. Status 409 with
 * a dedicated honest code so the client-side classification (definitive
 * 4xx under DEMO_FINTECH_WEBHOOK ⇒ no effect ⇒ KNOWN_ABSENT) is exactly
 * the accepted Phase 3 table, not a new semantic.
 */
export class ControlledFaultRejectionError extends DemoDomainError {
  public constructor(message: string) {
    super('CONTROLLED_FAULT_REJECTION', 409, message);
    this.name = 'ControlledFaultRejectionError';
  }
}

/**
 * Processing failed after a valid, authenticated delivery. The failed
 * financial transaction rolled back atomically; the failure is recorded
 * on the delivery/attempt honestly.
 */
export class ProcessingFailedError extends DemoDomainError {
  public constructor(message: string) {
    super('PROCESSING_FAILED', 500, message);
    this.name = 'ProcessingFailedError';
  }
}
