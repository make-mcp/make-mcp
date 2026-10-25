FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim
WORKDIR /app
COPY pyproject.toml ./
RUN uv sync --no-dev --no-install-project
COPY server.py ./
COPY data ./data
ENV MCP_TRANSPORT=http HOST=0.0.0.0 PORT=8080
EXPOSE 8080
CMD ["uv", "run", "--no-sync", "server.py"]
