# Imagem única do sistema: a mesma serve a API, o consumidor, o publisher, o reprocessador e a
# migration (o papel é escolhido por APP_ROLES / comando). Bun executa o TypeScript direto.
FROM oven/bun:1.4

WORKDIR /app

# Dependências primeiro: a camada só é refeita quando o lockfile muda.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations
COPY scripts/migrate.ts ./scripts/migrate.ts

ENV NODE_ENV=production
USER bun
EXPOSE 3000

CMD ["bun", "src/main.ts"]
