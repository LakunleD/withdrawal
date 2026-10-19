# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
COPY tests ./tests
RUN npm run build

# Development image: runs TypeScript directly and restarts on change.
# docker-compose.dev.yml bind-mounts ./src and ./sql over the copies below.
FROM deps AS dev
ENV NODE_ENV=development
COPY tsconfig.json ./
COPY src ./src
COPY sql ./sql
EXPOSE 3000
CMD ["npm", "run", "dev"]

# Test image: compiled sources + tests + dev dependencies.
FROM build AS test
ENV NODE_ENV=test
COPY sql ./sql
CMD ["npm", "test"]

# Production image: compiled app + production dependencies only, non-root.
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist/src ./dist/src
COPY sql ./sql
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/src/server.js"]
