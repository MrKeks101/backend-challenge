import { describe, expect, test } from "bun:test";
import { Glob } from "bun";

// Guardas estáticas das regras inegociáveis. Falham o build se alguém as quebrar.

const SRC = new Glob("src/**/*.ts");

async function sourceFiles(): Promise<{ path: string; text: string }[]> {
  const files: { path: string; text: string }[] = [];
  for await (const path of SRC.scan({ cwd: process.cwd() })) {
    files.push({ path: path.replaceAll("\\", "/"), text: await Bun.file(path).text() });
  }
  return files;
}

describe("AR-01: nada de number/float para dinheiro", () => {
  // Coerções numéricas são proibidas em src/. Uso legítimo e não monetário exige a marca
  // `// allow-number: <motivo>` na mesma linha.
  const FORBIDDEN = [/\bparseFloat\s*\(/, /\bparseInt\s*\(/, /\bNumber\s*\(/, /\.toFixed\s*\(/];

  test("src/ não usa parseFloat, parseInt, Number() nem toFixed", async () => {
    const violations: string[] = [];
    for (const { path, text } of await sourceFiles()) {
      text.split("\n").forEach((line, i) => {
        if (line.includes("allow-number:")) return;
        if (FORBIDDEN.some((re) => re.test(line)))
          violations.push(`${path}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(violations).toEqual([]);
  });
});

describe("camada de aplicação não conhece ORM, driver nem AWS", () => {
  const APPLICATION = /^src\/([^/]+\/application|shared\/application)\//;
  const FORBIDDEN_IMPORT = /from\s+["'](@mikro-orm\/|@aws-sdk\/|pg["'/]|express)/;

  test("as portas ficam puras (a infraestrutura é que implementa)", async () => {
    const violations: string[] = [];
    for (const { path, text } of await sourceFiles()) {
      if (!APPLICATION.test(path)) continue;
      text.split("\n").forEach((line, i) => {
        if (FORBIDDEN_IMPORT.test(line)) violations.push(`${path}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(violations).toEqual([]);
  });
});

describe("SQL: armadilhas conhecidas da stack", () => {
  test("nunca usar getConnection(): ele ignora a transação em curso (achado do spike do M1)", async () => {
    const violations: string[] = [];
    for (const { path, text } of await sourceFiles()) {
      text.split("\n").forEach((line, i) => {
        if (/\.getConnection\s*\(/.test(line)) violations.push(`${path}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(violations).toEqual([]);
  });

  test("travas de linha: `FOR UPDATE` só com SKIP LOCKED; para wallet/transação, `FOR NO KEY UPDATE`", async () => {
    // `FOR UPDATE` puro conflita com o `FOR KEY SHARE` que a FK toma ao inserir filhos: duas
    // transações que inserem e depois travam a mesma wallet ficam em deadlock (achado do M5).
    const violations: string[] = [];
    for (const { path, text } of await sourceFiles()) {
      text.split("\n").forEach((line, i) => {
        if (/^\s*(\/\/|\/\*|\*)/.test(line)) return; // comentários
        if (/FOR UPDATE(?!\s+SKIP LOCKED)/.test(line))
          violations.push(`${path}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(violations).toEqual([]);
  });
});

describe("AR-33: o domínio não depende de framework, ORM nem AWS", () => {
  const DOMAIN = /^src\/(shared\/kernel|[^/]+\/domain)\//;
  const FORBIDDEN_IMPORT = /from\s+["'](@nestjs\/|@mikro-orm\/|@aws-sdk\/|pg["'/]|express|zod)/;

  test("arquivos de domínio e kernel não importam pacotes de infraestrutura", async () => {
    const violations: string[] = [];
    for (const { path, text } of await sourceFiles()) {
      if (!DOMAIN.test(path)) continue;
      text.split("\n").forEach((line, i) => {
        if (FORBIDDEN_IMPORT.test(line)) violations.push(`${path}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(violations).toEqual([]);
  });
});
