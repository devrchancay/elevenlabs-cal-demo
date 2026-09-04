# syntax=docker/dockerfile:1

# ---------------------------------------------------------------------------
# Stage 1 — full dependencies and compilation
# ---------------------------------------------------------------------------
FROM node:22-alpine AS builder

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app

# Manifests first: if they do not change this layer is reused and the install
# does not run again on every build.
#
# --filter keeps this to the backend package. pnpm-workspace.yaml also lists
# `web`, but that is a static site with its own image and this one has no use
# for its dependencies.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter elevenlabs-agent-backend

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm run build

# ---------------------------------------------------------------------------
# Stage 2 — production dependencies only
# ---------------------------------------------------------------------------
FROM node:22-alpine AS deps

ENV PNPM_HOME=/pnpm
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod --filter elevenlabs-agent-backend

# ---------------------------------------------------------------------------
# Stage 3 — final image: no pnpm, no TypeScript, no source
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runner

ENV NODE_ENV=production
# Railway injects PORT; this value only applies when running elsewhere.
ENV PORT=3000

WORKDIR /app

# dumb-init forwards signals. Without it Node runs as PID 1, swallows SIGTERM,
# and the container takes ten seconds to die on every redeploy.
RUN apk add --no-cache dumb-init

COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

# The data directory exists and is writable by the non-root user.
RUN mkdir -p /app/data && chown -R node:node /app/data

# The node:22-alpine image already ships a `node` user. Never root.
USER node

EXPOSE 3000

# No curl in the image: Node performs the check itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/server.js"]
