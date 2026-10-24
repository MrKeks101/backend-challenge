/**
 * Sobe a infra efêmera de teste (PostgreSQL + MiniStack), roda as suítes de integração/concorrência
 * e derruba tudo, mesmo em caso de falha. Uso: `bun run test:integration [args do bun test]`.
 */
const COMPOSE = ["docker", "compose", "-f", "docker-compose.test.yml"];

async function run(cmd: string[]): Promise<number> {
  const proc = Bun.spawn(cmd, { stdout: "inherit", stderr: "inherit", env: process.env });
  return proc.exited;
}

const extraArgs = process.argv.slice(2);
let exitCode = 1;
try {
  const up = await run([...COMPOSE, "up", "-d", "--wait"]);
  if (up !== 0) throw new Error("falha ao subir a infra de teste");
  exitCode = await run(["bun", "test", "test/integration", "test/concurrency", ...extraArgs]);
} finally {
  await run([...COMPOSE, "down", "-v"]);
}
process.exit(exitCode);

export {};
