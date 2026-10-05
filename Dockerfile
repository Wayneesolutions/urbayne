# One image for everything: the API (with the built dashboard), the background worker, the migrator and the retention job.
# The command decides what runs; see infra/terraform.
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
COPY . .
RUN pnpm install --frozen-lockfile && pnpm build:dashboard

FROM node:22-slim
WORKDIR /app
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && rm -rf /var/lib/apt/lists/*
# Amazon RDS certificate bundle, so the database connection is encrypted AND verified (sslmode=verify-full).
RUN curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem -o /etc/ssl/rds-global-bundle.pem
ENV NODE_ENV=production NODE_EXTRA_CA_CERTS=/etc/ssl/rds-global-bundle.pem PORT=4000
COPY --from=build /app /app
RUN useradd --system --uid 10001 app && chown -R app /app
USER app
EXPOSE 4000
# Default: the API. Override the command for the worker (pnpm worker), migrations (pnpm db:migrate) or the retention job.
CMD ["pnpm", "--filter", "@cs/api", "start"]
