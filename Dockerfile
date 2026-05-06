FROM node:22-slim AS base

RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

WORKDIR /app

# ── dependencies ──────────────────────────────────────────────
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

# ── application ───────────────────────────────────────────────
COPY src/ src/
COPY tsconfig.json ./

RUN mkdir -p /app/data && touch /app/.env

ENTRYPOINT ["pnpm"]
CMD ["trade"]
