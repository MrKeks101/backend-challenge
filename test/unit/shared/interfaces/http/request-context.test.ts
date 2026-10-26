import { describe, expect, test } from "bun:test";
import type { CallHandler, ExecutionContext } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { defer, lastValueFrom, of } from "rxjs";
import { RequestContext } from "../../../../../src/shared/application/request-context";
import {
  CORRELATION_HEADER,
  CorrelationMiddleware,
} from "../../../../../src/shared/interfaces/http/correlation";
import { RequestContextInterceptor } from "../../../../../src/shared/interfaces/http/request-context.interceptor";

const httpContext = (request: object): ExecutionContext =>
  ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext;

describe("RequestContextInterceptor", () => {
  test("o handler enxerga o correlationId da requisição, inclusive depois de await", async () => {
    let seen: string | undefined;
    const handler: CallHandler = {
      handle: () =>
        defer(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          seen = RequestContext.current().correlationId;
          return "ok";
        }),
    };

    const result = await lastValueFrom(
      new RequestContextInterceptor().intercept(
        httpContext({ correlationId: "http-corr" }),
        handler,
      ),
    );

    expect(result).toBe("ok");
    expect(seen).toBe("http-corr");
  });

  test("requisições simultâneas não misturam correlationId", async () => {
    const run = (id: string, delay: number) => {
      const handler: CallHandler = {
        handle: () =>
          defer(async () => {
            await new Promise((resolve) => setTimeout(resolve, delay));
            return RequestContext.current().correlationId;
          }),
      };
      return lastValueFrom(
        new RequestContextInterceptor().intercept(httpContext({ correlationId: id }), handler),
      );
    };

    expect(await Promise.all([run("a", 15), run("b", 1), run("c", 8)])).toEqual(["a", "b", "c"]);
  });

  test("o contexto não sobra depois que a requisição termina", async () => {
    const handler: CallHandler = { handle: () => of(1) };

    await lastValueFrom(
      new RequestContextInterceptor().intercept(httpContext({ correlationId: "x" }), handler),
    );

    expect(RequestContext.current()).toEqual({});
  });

  test("erro do handler segue para o filtro de exceções", async () => {
    const handler: CallHandler = {
      handle: () =>
        defer(async () => {
          throw new Error("boom");
        }),
    };

    await expect(
      lastValueFrom(
        new RequestContextInterceptor().intercept(httpContext({ correlationId: "x" }), handler),
      ),
    ).rejects.toThrow("boom");
  });
});

describe("CorrelationMiddleware", () => {
  function run(incoming?: string, statusCode = 201) {
    const headers = new Map<string, string>();
    const finish: (() => void)[] = [];
    const req = {
      method: "POST",
      path: "/transactions",
      header: (name: string) => (name === CORRELATION_HEADER ? incoming : undefined),
      body: { money: { amount: "25.00", currency: "BRL" } },
    } as unknown as Request & { correlationId?: string };
    const res = {
      statusCode,
      setHeader: (name: string, value: string) => void headers.set(name, value),
      on: (_event: string, listener: () => void) => void finish.push(listener),
    } as unknown as Response;
    const middleware = new CorrelationMiddleware();
    const logs: Record<string, unknown>[] = [];
    (middleware as unknown as { logger: { log: (f: Record<string, unknown>) => void } }).logger = {
      log: (fields) => void logs.push(fields),
    };
    middleware.use(req, res, (() => undefined) as NextFunction);
    for (const listener of finish) listener();
    return { req, headers, logs };
  }

  test("aceita o x-correlation-id seguro do cliente e o devolve no header", () => {
    const { req, headers } = run("client-id-1");

    expect(req.correlationId).toBe("client-id-1");
    expect(headers.get(CORRELATION_HEADER)).toBe("client-id-1");
  });

  test("gera um id quando o do cliente falta ou é inseguro", () => {
    expect(run().req.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(run("com espaço\nquebra").req.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  test("uma linha de acesso por requisição, com correlationId e sem corpo", () => {
    const { logs, req } = run("abc", 422);

    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      event: "http_request",
      correlationId: "abc",
      method: "POST",
      path: "/transactions",
      status: 422,
    });
    expect(typeof logs[0]?.durationMs).toBe("number");
    expect(JSON.stringify(logs[0])).not.toContain("25.00");
    expect(req.correlationId).toBe("abc");
  });
});
