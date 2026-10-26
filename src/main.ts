import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadEnv } from "./shared/infrastructure/config/env";
import { AppLogger, createPinoLogger } from "./shared/infrastructure/observability/app-logger";

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, {
    logger: new AppLogger(createPinoLogger({ level: env.LOG_LEVEL })),
  });
  app.enableShutdownHooks();
  if (env.APP_ROLES.has("api")) {
    await app.listen(env.PORT);
  } else {
    // Processo só de workers (publisher, consumer, reprocessor): não abre porta HTTP.
    await app.init();
  }
}

bootstrap().catch((err: unknown) => {
  // Ainda JSON (AR-56) e sem a mensagem do erro, que pode trazer a URL do banco.
  console.error(
    JSON.stringify({
      level: "fatal",
      event: "bootstrap_failed",
      error: err instanceof Error ? err.name : typeof err,
    }),
  );
  process.exit(1);
});
