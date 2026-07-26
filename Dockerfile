# syntax=docker/dockerfile:1

ARG BUN_VERSION=1.2.15

FROM oven/bun:${BUN_VERSION}-alpine AS dependencies
WORKDIR /app

COPY --chown=bun:bun package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:${BUN_VERSION}-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    TRACE_DIR=/var/lib/k8s-incident-triage/traces

COPY --from=dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun package.json bun.lock tsconfig.json ./
COPY --chown=bun:bun src ./src

RUN mkdir -p /var/lib/k8s-incident-triage/traces
RUN chown -R bun:bun /var/lib/k8s-incident-triage

USER bun

EXPOSE 3000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD bun -e "const port = Bun.env.PORT ?? '3000'; const response = await fetch('http://127.0.0.1:' + port + '/healthz'); if (response.status !== 200) process.exit(1)"

CMD ["bun", "run", "src/server.ts"]
