# One file, two targets: `web` (static site behind nginx) and `api` (the Worker on the
# local workerd runtime, with D1 and Durable Object storage persisted under /data).
FROM node:24.20.0-bookworm-slim AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/* && corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile

FROM deps AS web-build
ARG VITE_API_URL
ARG VITE_TURNSTILE_SITE_KEY
RUN test -n "$VITE_API_URL" || { echo "VITE_API_URL build arg is empty; set it in the Dokploy stack env."; exit 1; }
RUN pnpm --filter @coinposh/web build

FROM nginx:1.29-alpine AS web
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/apps/web/dist /usr/share/nginx/html

FROM deps AS api
ENV WRANGLER_SEND_METRICS=false
WORKDIR /app/apps/server
EXPOSE 8787
VOLUME /data
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/app/deploy/api-entrypoint.sh"]
