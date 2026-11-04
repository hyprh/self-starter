# Used by MCP registries (such as Glama) to build and verify stdio MCP introspection
# (`initialize` and `tools/list`). For full local daemon scheduling and session
# delivery, install Self-Starter on your macOS or Linux host.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
COPY test ./test
RUN npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
 && node node_modules/deno/install.cjs \
 && npm cache clean --force
COPY --from=build /app/dist/src ./dist/src
COPY codex-plugin ./codex-plugin
COPY cc-plugin ./cc-plugin
COPY agy-plugin ./agy-plugin
COPY zcode-plugin ./zcode-plugin
COPY opencode-plugin ./opencode-plugin
COPY recipes ./recipes
USER node
ENTRYPOINT ["node", "dist/src/cli/main.js", "mcp"]
