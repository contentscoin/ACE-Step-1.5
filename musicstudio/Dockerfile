# The gateway image (roadmap §4.4, slice S6).
#
# Two stages, and the reason is `bcrypt`: it is a native module, and while it publishes
# prebuilt binaries for common platforms, an image that depended on a prebuild being available
# would fail to build on the day one is not. The build stage has a toolchain and can compile;
# the runtime stage does not carry it.
#
# TypeScript is run, not built. `npm start` is `tsx api/gateway/main.ts`, and `tsx` is a runtime
# dependency for exactly this reason — the product layer has no bundle step and adding one for
# the container alone would mean the image runs code the test suite never does.

FROM node:22-bookworm AS deps
WORKDIR /app
# The lockfile alone, so this layer is rebuilt only when dependencies actually change.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json tsconfig.json ./
COPY api ./api
COPY adapters ./adapters
COPY domain ./domain
COPY services ./services
COPY db ./db
COPY scripts ./scripts

# Where the filesystem object store keeps audio. A volume is mounted here by compose; without
# one the audio lives in the container's writable layer and dies with it.
ENV MUSICSTUDIO_OBJECT_STORE_DIR=/data/objects
RUN mkdir -p /data/objects && chown -R node:node /data
VOLUME ["/data/objects"]

# Not root. The gateway writes only to the object store, and the image makes that literal.
USER node

ENV MUSICSTUDIO_HOST=0.0.0.0 \
    MUSICSTUDIO_PORT=8080
EXPOSE 8080

# `/health` is liveness — the process answers. Readiness (`/ready`, which probes the database,
# Redis, the sidecar and the engine) is deliberately not the container's health check: a
# gateway whose engine is down is degraded, not dead, and restarting it would not bring the
# engine back.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
