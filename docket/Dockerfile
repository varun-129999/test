FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY server server
COPY web web
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
# Set TZ (e.g. Asia/Kolkata) and DOCKET_TOKEN at run time. DOCKET_REQUIRE_DISK makes the server
# refuse to start unless /data is a mounted volume, so data never lands on the container layer.
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DOCKET_DB=/data/docket.db DOCKET_REQUIRE_DISK=1
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/server/package.json server/
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
VOLUME /data
EXPOSE 8787
CMD ["node", "--disable-warning=ExperimentalWarning", "server/dist/index.js"]
