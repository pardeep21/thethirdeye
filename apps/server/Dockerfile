# TheThirdEye server (Node 22 slim: better-sqlite3 v13 + openai v7 need
# Node >= 22; Node 20 segfaults on DB open). Faces run as FACES=stub here: face
# recognition needs the Python sidecar (apps/faces) next to the server,
# which the cloud deploy does not run.
#
# Build from the repo root:
#   docker build -f apps/server/Dockerfile -t thethirdeye-server .
# Run:
#   docker run -p 8080:8080 -e PROVIDER=mock thethirdeye-server
#   curl http://127.0.0.1:8080/health
FROM node:22-slim AS build
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
RUN npm ci --workspace=@thethirdeye/server --include-workspace-root=false
COPY apps/server/tsconfig.json apps/server/tsconfig.json
COPY apps/server/src apps/server/src
RUN npm run build -w @thethirdeye/server \
  && npm prune --omit=dev --workspace=@thethirdeye/server --include-workspace-root=false

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production \
  PORT=8080 \
  PROVIDER=mock \
  FACES=stub \
  THETHIRDEYE_DB=/data/thethirdeye.db
# The default DB lives here; mount a volume/disk over /data to persist it.
RUN mkdir -p /data
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/apps/server/dist /app/dist
COPY --from=build /app/apps/server/package.json /app/package.json
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
