/** Endpoints da infra de teste (docker-compose.test.yml). Sobrescrevíveis por env. */
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://wagering:wagering@localhost:55432/wagering";
export const TEST_SQS_ENDPOINT = process.env.TEST_SQS_ENDPOINT ?? "http://localhost:45566";
