# Faremeter facilitator wrapped for Cloudflare Containers.
#
# Builds the upstream faremeter/faremeter monorepo's apps/facilitator (Hono +
# @hono/node-server). Configured via env (not file-mounted keypairs) per the
# config-loader patch we upstream in week 1.

FROM node:22-alpine AS base
RUN apk add --no-cache git
RUN npm install -g pnpm@10.12.1

# ---------------------------------------------------------------------------
# Vendor Faremeter. Pin a known release; bump via PR.
# ---------------------------------------------------------------------------
FROM base AS vendor
WORKDIR /vendor
ARG FAREMETER_REF=v0.21.0
RUN git clone --depth 1 --branch ${FAREMETER_REF} https://github.com/faremeter/faremeter.git
WORKDIR /vendor/faremeter

# ---------------------------------------------------------------------------
# Apply our env-config patch BEFORE install so any tsc compilation that runs
# during install picks up the patched source. ~14 lines; verified against
# v0.21.0.
# ---------------------------------------------------------------------------
COPY patches/faremeter-env-config.patch /tmp/patches/
RUN git apply /tmp/patches/faremeter-env-config.patch

RUN pnpm install -r --frozen-lockfile
RUN pnpm --filter '@faremeter/facilitator-app' build || pnpm --filter './apps/facilitator' build || true

# ---------------------------------------------------------------------------
# Runtime image
# ---------------------------------------------------------------------------
FROM node:22-alpine AS runtime
RUN npm install -g pnpm@10.12.1
WORKDIR /app
COPY --from=vendor /vendor/faremeter /app/faremeter
WORKDIR /app/faremeter/apps/facilitator

# Faremeter expects these env vars (post-patch).
# Set as Cloudflare Worker secrets and forwarded to the container.
ENV NODE_ENV=production

EXPOSE 3000

CMD ["pnpm", "tsx", "src"]
