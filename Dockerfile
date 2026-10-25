# make-mcp in a container: the web UI by default, any CLI command otherwise.
#
#   docker run --rm -p 127.0.0.1:4321:4321 -v "$PWD:/workspace" -e MAKE_MCP_HOST_WORKSPACE="$PWD" ghcr.io/make-mcp/make-mcp
#   docker run --rm -v "$PWD:/workspace" -e MAKE_MCP_HOST_WORKSPACE="$PWD" ghcr.io/make-mcp/make-mcp generate --target daisyui --yes
#
# MAKE_MCP_HOST_WORKSPACE makes run commands and .mcp.json entries use host paths instead of /workspace.
# Optional for APIs without an OpenAPI spec: -e ANTHROPIC_API_KEY or -e MAKE_MCP_LLM_BASE_URL -e MAKE_MCP_LLM_MODEL.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json tsconfig.json ./
COPY packages/core/package.json packages/core/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/cli/package.json packages/cli/
RUN npm ci --ignore-scripts
COPY packages packages
RUN npx tsc -b packages/cli

FROM node:22-slim
# uv runs and tests generated Python servers.
COPY --from=ghcr.io/astral-sh/uv:0.12.1 /uv /uvx /usr/local/bin/
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/mcp-server/package.json packages/mcp-server/
COPY packages/cli/package.json packages/cli/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /app/packages/core/dist packages/core/dist
COPY packages/core/templates packages/core/templates
COPY --from=build /app/packages/mcp-server/dist packages/mcp-server/dist
COPY --from=build /app/packages/cli/dist packages/cli/dist
COPY packages/cli/ui packages/cli/ui
RUN chmod +x packages/cli/dist/index.js && ln -s /app/packages/cli/dist/index.js /usr/local/bin/make-mcp

ENV NODE_ENV=production MAKE_MCP_CONTAINER=1
USER node
WORKDIR /workspace
EXPOSE 4321
ENTRYPOINT ["make-mcp"]
# Listens on all container interfaces; every API call still needs the token printed at start.
CMD ["ui", "--host", "0.0.0.0", "--port", "4321"]
