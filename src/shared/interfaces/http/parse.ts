import type { z } from "zod";
import { ApiProblem } from "./problem";

/** Valida na borda. Falha vira 400 `INVALID_PAYLOAD` com `errors[]` (caminho + motivo, sem ecoar o valor). */
export function parseOrThrow<S extends z.ZodType>(schema: S, input: unknown): z.infer<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new ApiProblem(
    400,
    "INVALID_PAYLOAD",
    "request failed validation",
    result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
  );
}
