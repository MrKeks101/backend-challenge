import { z } from "zod";

/** Papéis que um processo pode assumir (ARCHITECTURE §1): a mesma imagem, ligados por `APP_ROLES`. */
export const APP_ROLES = ["api", "publisher", "consumer", "reprocessor"] as const;
export type AppRole = (typeof APP_ROLES)[number];

const roles = z
  .string()
  .default(APP_ROLES.join(","))
  .transform((value, ctx): ReadonlySet<AppRole> => {
    const parsed = value
      .split(",")
      .map((role) => role.trim())
      .filter((role) => role.length > 0);
    const unknown = parsed.filter((role) => !(APP_ROLES as readonly string[]).includes(role));
    if (parsed.length === 0 || unknown.length > 0) {
      ctx.addIssue({
        code: "custom",
        message: `must be a comma-separated list of ${APP_ROLES.join("|")}${
          unknown.length > 0 ? ` (unknown: ${unknown.join(",")})` : ""
        }`,
      });
      return z.NEVER;
    }
    return new Set(parsed as AppRole[]);
  });

const positiveInt = (fallback: number) => z.coerce.number().int().min(1).default(fallback);

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  APP_ROLES: roles,
  DATABASE_URL: z.string().min(1),
  AWS_REGION: z.string().min(1).default("us-east-1"),
  AWS_ACCESS_KEY_ID: z.string().min(1),
  AWS_SECRET_ACCESS_KEY: z.string().min(1),
  SQS_ENDPOINT: z.string().url().optional(),
  /** Prefixo dos nomes das filas (isola ambientes/testes que compartilham o mesmo SQS). */
  SQS_QUEUE_PREFIX: z
    .string()
    .regex(/^[A-Za-z0-9_-]{0,40}$/, "letters, digits, '-' and '_' only")
    .default(""),
  /** Pausa do publisher quando a outbox está vazia. */
  OUTBOX_POLL_INTERVAL_MS: positiveInt(500),
  OUTBOX_BATCH_SIZE: positiveInt(20),
  /** Quanto tempo uma mensagem reivindicada fica "emprestada" a um publisher (crash recovery). */
  OUTBOX_LEASE_MS: positiveInt(30_000),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment: ${issues}`);
  }
  return parsed.data;
}
