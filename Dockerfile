# syntax=docker/dockerfile:1
# One image: the NestJS API serves the built dashboard, runs migrations on start and owns the MLLP listeners.

FROM node:22.23.4-alpine AS build
WORKDIR /app
ENV TURBO_TELEMETRY_DISABLED=1 NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/schemas/package.json packages/schemas/
RUN npm ci
COPY packages ./packages
COPY apps ./apps
RUN npx turbo run build --filter=@ackwell/api --filter=@ackwell/web
RUN npm prune --omit=dev && mkdir -p apps/api/node_modules packages/schemas/node_modules

FROM node:22.23.4-alpine
ENV NODE_ENV=production PORT=3000 FILE_ROOT=/data/files
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/schemas/package.json packages/schemas/
COPY --from=build /app/packages/schemas/dist packages/schemas/dist
COPY --from=build /app/packages/schemas/node_modules packages/schemas/node_modules
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/dist apps/api/dist
COPY --from=build /app/apps/api/drizzle apps/api/drizzle
COPY --from=build /app/apps/api/node_modules apps/api/node_modules
COPY --from=build /app/apps/web/dist apps/web/dist
RUN mkdir -p /data/files && chown node:node /data/files
USER node
# 3000 = dashboard + API; 6100-6150 = default MLLP_PORT_RANGE (publish the range you configure)
EXPOSE 3000 6100-6150
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1
STOPSIGNAL SIGTERM
CMD ["node", "apps/api/dist/main.js"]
