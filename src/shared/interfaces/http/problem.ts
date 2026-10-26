export interface ProblemError {
  path: string;
  message: string;
}

/** Erro já no vocabulário HTTP (RFC 9457), com `code` estável para o cliente decidir se reenvia. */
export class ApiProblem extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail: string,
    readonly errors?: readonly ProblemError[],
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(detail);
    this.name = "ApiProblem";
  }
}
