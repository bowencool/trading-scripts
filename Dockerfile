FROM ubuntu:noble

ARG DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates && \
    curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && \
    apt-get install -y --no-install-recommends nodejs && \
    corepack enable && corepack prepare pnpm@10.33.2 --activate && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV DB_PATH=/app/db/stock_analysis.db
ENV MARKET_DATA_PROVIDER=longbridge
ENV BROKER_PROVIDER=longbridge

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile && pnpm store prune

COPY src/ src/
COPY tsconfig.json ./

RUN mkdir -p /app/db && touch /app/.env

ENTRYPOINT ["pnpm", "--silent"]
CMD ["trade"]
