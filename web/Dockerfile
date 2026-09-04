# syntax=docker/dockerfile:1
#
# Build context is the REPOSITORY ROOT, not web/. The lockfile lives at the root
# because this is a pnpm workspace, and installing without it would not be
# reproducible. From the root:
#
#   docker build -f web/Dockerfile .

# ---------------------------------------------------------------------------
# Stage 1 — static build with Vite
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json ./web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter elevenlabs-agent-web

COPY web ./web

# Vite inlines VITE_* variables at build time, so they are build arguments and
# not runtime environment. Changing either one means rebuilding the image.
#
# VITE_BACKEND_URL is the address the VISITOR'S BROWSER will call, so it cannot
# be the compose service name: from the browser, `http://api:3000` does not
# resolve. Locally that means http://localhost:3000.
ARG VITE_ELEVENLABS_AGENT_ID=""
ARG VITE_BACKEND_URL="http://localhost:3000"
ENV VITE_ELEVENLABS_AGENT_ID=$VITE_ELEVENLABS_AGENT_ID
ENV VITE_BACKEND_URL=$VITE_BACKEND_URL

RUN pnpm --filter elevenlabs-agent-web build

# ---------------------------------------------------------------------------
# Stage 2 — nginx serving the static output
# ---------------------------------------------------------------------------
# The unprivileged image runs as a non-root user and listens on 8080.
FROM nginxinc/nginx-unprivileged:1-alpine AS runner

COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=builder /app/web/dist /usr/share/nginx/html

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:8080/ || exit 1
