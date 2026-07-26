FROM node:22.17.0-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY packages/core/package.json packages/core/package.json
COPY packages/guardianctl/package.json packages/guardianctl/package.json
COPY apps/control-plane/package.json apps/control-plane/package.json
RUN npm ci
COPY tsconfig.base.json ./
COPY packages packages
COPY apps apps
RUN npm run build

FROM node:22.17.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/package.json /app/package-lock.json* ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/control-plane ./apps/control-plane
USER node
EXPOSE 3000
CMD ["node", "apps/control-plane/dist/server.js"]
