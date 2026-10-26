import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadEnv } from "./shared/infrastructure/config/env";

async function bootstrap(): Promise<void> {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  if (env.APP_ROLES.has("api")) {
    await app.listen(env.PORT);
  } else {
    // Processo só de workers (publisher, consumer, reprocessor): não abre porta HTTP.
    await app.init();
  }
}

bootstrap().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
