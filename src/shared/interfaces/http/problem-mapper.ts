import { HttpException } from "@nestjs/common";
import { classifyError } from "../../infrastructure/persistence/error-classifier";
import {
  DomainError,
  InvalidArgumentError,
  InvalidMoneyError,
  MoneyOverflowError,
} from "../../kernel";
import { ApiProblem, type ProblemError } from "./problem";

export interface MappedProblem {
  status: number;
  code: string;
  title: string;
  detail: string;
  errors?: readonly ProblemError[];
  headers: Readonly<Record<string, string>>;
  /** Só 5xx: vai para o log (nome e classificação, nunca a mensagem, que pode ter dados). */
  loggable?: { name: string; kind: string; reason: string; sqlState?: string };
}

const TITLES: Readonly<Record<number, string>> = {
  400: "Bad Request",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  413: "Payload Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Entity",
  500: "Internal Server Error",
  503: "Service Unavailable",
};

const titleFor = (status: number): string => TITLES[status] ?? "Error";

/** Códigos de domínio com status próprio. O resto de `DomainError` é 400 (entrada) ou 422. */
const DOMAIN_STATUS: Readonly<Record<string, number>> = {
  WALLET_NOT_FOUND: 404,
  WALLET_ALREADY_EXISTS: 409,
  INVALID_CURSOR: 400,
  TRANSACTION_NOT_FOUND: 404,
  IDEMPOTENCY_KEY_CONFLICT: 409,
  EXTERNAL_TRANSACTION_ID_CONFLICT: 409,
};

/** Entrada malformada que o domínio detecta ao construir objetos: é problema do payload. */
const isInputError = (error: DomainError): boolean =>
  error instanceof InvalidMoneyError ||
  error instanceof MoneyOverflowError ||
  error instanceof InvalidArgumentError ||
  error.code === "INVALID_WALLET" ||
  error.code === "INVALID_WAGER_TRANSACTION";

const RETRY_AFTER_SECONDS = "1";

/** Traduz qualquer exceção para um problema HTTP. Pura: não toca em request nem response. */
export function toProblem(exception: unknown): MappedProblem {
  if (exception instanceof ApiProblem) {
    return {
      status: exception.status,
      code: exception.code,
      title: titleFor(exception.status),
      detail: exception.detail,
      ...(exception.errors ? { errors: exception.errors } : {}),
      headers: exception.headers,
    };
  }

  if (exception instanceof DomainError) return fromDomainError(exception);

  // Erros do body-parser do Express (JSON malformado, corpo grande demais) trazem `status` e `type`.
  const parserError = asBodyParserError(exception);
  if (parserError) return parserError;

  if (exception instanceof HttpException) {
    // O Nest embrulha os erros do body-parser (JSON malformado) em BadRequestException.
    return fromHttpException(exception.getStatus());
  }

  const classification = classifyError(exception);
  const loggable = {
    name: exception instanceof Error ? exception.name : typeof exception,
    kind: classification.kind,
    reason: classification.reason,
    ...(classification.sqlState ? { sqlState: classification.sqlState } : {}),
  };
  if (classification.kind === "TRANSIENT") {
    return {
      status: 503,
      code: "SERVICE_UNAVAILABLE",
      title: titleFor(503),
      detail: "temporary failure; retrying the same request is safe",
      headers: { "Retry-After": RETRY_AFTER_SECONDS },
      loggable,
    };
  }
  return {
    status: 500,
    code: "INTERNAL_ERROR",
    title: titleFor(500),
    detail: "unexpected error",
    headers: {},
    loggable,
  };
}

function fromHttpException(status: number): MappedProblem {
  const known: Readonly<Record<number, { code: string; detail: string }>> = {
    400: { code: "INVALID_PAYLOAD", detail: "request body could not be parsed" },
    404: { code: "NOT_FOUND", detail: "route not found" },
    405: { code: "METHOD_NOT_ALLOWED", detail: "method not allowed for this route" },
    413: { code: "PAYLOAD_TOO_LARGE", detail: "request body is too large" },
  };
  const { code, detail } = known[status] ?? { code: "HTTP_ERROR", detail: titleFor(status) };
  return { status, code, title: titleFor(status), detail, headers: {} };
}

function fromDomainError(error: DomainError): MappedProblem {
  const known = DOMAIN_STATUS[error.code];
  if (known !== undefined) {
    return {
      status: known,
      code: error.code,
      title: titleFor(known),
      detail: error.message,
      headers: {},
    };
  }
  if (isInputError(error)) {
    return {
      status: 400,
      code: "INVALID_PAYLOAD",
      title: titleFor(400),
      detail: error.message,
      headers: {},
    };
  }
  return {
    status: 422,
    code: error.code,
    title: titleFor(422),
    detail: error.message,
    headers: {},
  };
}

function asBodyParserError(exception: unknown): MappedProblem | null {
  if (typeof exception !== "object" || exception === null) return null;
  const { type, status } = exception as { type?: unknown; status?: unknown };
  if (typeof type !== "string" || typeof status !== "number") return null;
  if (type === "entity.parse.failed") {
    return {
      status: 400,
      code: "INVALID_PAYLOAD",
      title: titleFor(400),
      detail: "request body is not valid JSON",
      headers: {},
    };
  }
  if (type === "entity.too.large") {
    return {
      status: 413,
      code: "PAYLOAD_TOO_LARGE",
      title: titleFor(413),
      detail: "request body is too large",
      headers: {},
    };
  }
  if (type === "charset.unsupported" || type === "encoding.unsupported") {
    return {
      status: 415,
      code: "UNSUPPORTED_MEDIA_TYPE",
      title: titleFor(415),
      detail: "unsupported body encoding",
      headers: {},
    };
  }
  return null;
}
