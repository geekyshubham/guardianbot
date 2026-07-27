FROM node:22.17.0-bookworm-slim@sha256:b04ce4ae4e95b522112c2e5c52f781471a5cbc3b594527bcddedee9bc48c03a0 AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/defectdojo/package.json packages/defectdojo/package.json
COPY packages/monitoring/package.json packages/monitoring/package.json
COPY packages/guardianctl/package.json packages/guardianctl/package.json
COPY apps/control-plane/package.json apps/control-plane/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/apps/control-plane/package.json ./apps/control-plane/package.json
COPY --from=build /app/apps/control-plane/dist ./apps/control-plane/dist
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/healthz').then((response)=>process.exit(response.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "apps/control-plane/dist/server.js"]
