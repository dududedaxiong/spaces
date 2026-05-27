FROM node:24-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=7860
ENV APP_PORT=4173
ENV REMOTE_FOLDER=huggingface:notes

RUN apt-get update \
  && apt-get install -y --no-install-recommends rclone ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --prod --frozen-lockfile

COPY . .
RUN chmod +x scripts/docker-entrypoint.sh

EXPOSE 7860

ENTRYPOINT ["scripts/docker-entrypoint.sh"]
