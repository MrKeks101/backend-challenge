import { describe, expect, test } from "bun:test";
import { InvalidCursorError } from "../../../../src/wallet/application/errors";
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
} from "../../../../src/wallet/application/ledger-cursor";

const WALLET = "0192f291-27dd-7d3f-8071-5f8685deef37";
const OTHER = "0192f291-27dd-7d3f-8071-5f8685deef38";
const forge = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

describe("cursor do ledger", () => {
  test("ida e volta preserva o seq", () => {
    for (const seq of ["1", "42", "999999999999999999"]) {
      expect(decodeLedgerCursor(encodeLedgerCursor(WALLET, seq), WALLET)).toBe(seq);
    }
  });

  test("é opaco: base64url, sem o seq nem a wallet em texto claro", () => {
    const cursor = encodeLedgerCursor(WALLET, "12345");
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cursor).not.toContain("12345");
    expect(cursor).not.toContain(WALLET);
  });

  test("é determinístico: o mesmo ponto gera o mesmo cursor", () => {
    expect(encodeLedgerCursor(WALLET, "7")).toBe(encodeLedgerCursor(WALLET, "7"));
  });

  test("recusa cursor de outra wallet", () => {
    expect(() => decodeLedgerCursor(encodeLedgerCursor(WALLET, "7"), OTHER)).toThrow(
      InvalidCursorError,
    );
  });

  const bad: [string, string][] = [
    ["texto qualquer", "lixo"],
    ["vazio", ""],
    ["JSON truncado", encodeLedgerCursor(WALLET, "7").slice(0, -4)],
    ["JSON que não é objeto", forge([1, 2])],
    ["null", forge(null)],
    ["versão desconhecida", forge({ v: 2, w: WALLET, s: "7" })],
    ["sem versão", forge({ w: WALLET, s: "7" })],
    ["seq numérico (não string)", forge({ v: 1, w: WALLET, s: 7 })],
    ["seq negativo", forge({ v: 1, w: WALLET, s: "-1" })],
    ["seq com injeção de SQL", forge({ v: 1, w: WALLET, s: "1; DROP TABLE wallets" })],
    ["seq decimal", forge({ v: 1, w: WALLET, s: "1.5" })],
    ["seq grande demais para bigint seguro", forge({ v: 1, w: WALLET, s: "1".repeat(19) })],
    ["seq vazio", forge({ v: 1, w: WALLET, s: "" })],
  ];
  for (const [label, cursor] of bad) {
    test(`recusa: ${label}`, () => {
      expect(() => decodeLedgerCursor(cursor, WALLET)).toThrow(InvalidCursorError);
    });
  }
});
