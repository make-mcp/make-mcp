# make-mcp

**[make-mcp.net](https://make-mcp.net)** · Generate an MCP server for **any library, product or API** – from its `llms.txt`, documentation site,
OpenAPI/Swagger spec or source code. Version-exact, offline-capable, and no API key needed when you run it
from your coding agent.

> Free software shouldn't need a paid MCP server. If the docs are public, your agent can have them.

## How it works

```
"Build me an MCP for daisyUI"
  → detect   package.json/lockfile → daisyui 5.7.50 · npm → MIT, github.com/saadeghi/daisyui, tag v5.7.50
             daisyui.com/llms.txt (declares 5.7.x)
  → ask      only what is unknown: "Look up knowledge or perform actions?" · "Register in this project?"
  → confirm  summary of sources, license handling and output
  → generate TypeScript or Python server with search_docs / get_page / list_topics / get_component
  → test     install, build, start over stdio, smoke call
  → register .mcp.json / .cursor/mcp.json (diff shown first)
```

Two kinds of servers, combinable:

| Mode | Source | Tools |
|---|---|---|
| `docs` | llms-full.txt → llms.txt → repo docs at the version tag → website → README → local checkout | `search_docs`, `get_page`, `list_topics`, `get_component`; one resource per page |
| `api` | OpenAPI 3.x / Swagger 2.0, or prose API docs (extracted by an LLM, see below) | one tool per operation (with read-only/destructive hints), GET resources, auth via env vars, version via path/header/query; above 40 operations three tools instead: `list_operations`, `describe_operation`, `call_operation` |

Versions are read from npm lockfiles (`package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`) and Python projects
(`uv.lock`, `poetry.lock`, `pdm.lock`, `Pipfile.lock`, a local `.venv`, `requirements*.txt`, `pyproject.toml`).

### APIs without an OpenAPI spec

If an API is only documented in prose, an LLM extracts the operations – inside a coding agent that is the agent's
own model, so no API key is needed. Every operation must quote the page it came from; make-mcp rejects operations
whose quote, path or method cannot be found on that page, and takes base URL and auth only when the docs state them.
The CLI uses your own model instead:

```bash
ANTHROPIC_API_KEY=… npx @make-mcp/cli create https://docs.example.com
MAKE_MCP_LLM_BASE_URL=http://localhost:11434/v1 MAKE_MCP_LLM_MODEL=qwen3 npx @make-mcp/cli create …   # Ollama & co.
```

Generated servers speak **stdio** and **Streamable HTTP** (legacy SSE via flag), ship a Dockerfile for
Cloud Run & co., and contain no dependency on this generator.

## Install

### Claude Code (plugin)

```bash
/plugin marketplace add make-mcp/make-mcp
/plugin install make-mcp@make-mcp
/make-mcp:create daisyui
```

### Cursor, Codex, Windsurf, Claude Desktop, …

Add the MCP server (`npx -y @make-mcp/cli mcp`) and optionally the agent guidance from
[`plugins/agents-md`](plugins/agents-md/README.md). Clients with prompt support can start with `create_mcp`.

### CLI

```bash
npx @make-mcp/cli create daisyui                       # interactive
npx @make-mcp/cli generate --target https://api.example.com/openapi.json --lang py --yes
npx @make-mcp/cli test ./mcp-servers/daisyui-mcp
```

### Web UI

The same flow in the browser – detect, answer, preview, generate, download as ZIP, smoke-test, register:

```bash
npx @make-mcp/cli ui            # prints http://127.0.0.1:4321/#t=<token>
```

It listens on 127.0.0.1 only and every API call needs the token from the printed link.

### Docker

```bash
docker run --rm -p 127.0.0.1:4321:4321 -v "$PWD:/workspace" -e MAKE_MCP_HOST_WORKSPACE="$PWD" ghcr.io/make-mcp/make-mcp
docker run --rm -v "$PWD:/workspace" -e MAKE_MCP_HOST_WORKSPACE="$PWD" ghcr.io/make-mcp/make-mcp generate --target daisyui --yes
```

The image contains Node.js and uv, so generated TypeScript and Python servers can be tested inside it.
`MAKE_MCP_HOST_WORKSPACE` makes run commands and `.mcp.json` entries point to your host paths.

## What it asks

Everything that can be detected is detected; the rest is asked (max. 4 questions per round, defaults pre-selected):

| Question | Asked when |
|---|---|
| Where are the docs / the spec? | nothing found |
| Is the source code accessible (repo URL, local path)? | no repository and no docs found |
| Which version? | not exact in a lockfile |
| Knowledge lookup, API actions or both? | not obvious from the source |
| Authentication | API mode and the spec declares none |
| All endpoints or some tags? | more than 40 operations |
| TypeScript or Python? | workspace language unclear |
| Register with the agent? | always |

## Licenses and etiquette

- The target's license is **detected, not asked**. Docs are embedded only under permissive licenses
  (MIT, Apache-2.0, BSD, ISC, CC0, CC-BY…). Otherwise the generated server downloads them on the user's
  machine at install time (`npm run refresh`) and caches them in `~/.cache/make-mcp` – nothing is redistributed.
- robots.txt and TDM reservations (`tdm-reservation` header, `/.well-known/tdmrep.json`, § 44b UrhG) are honoured.
- Content behind logins or paywalls is never fetched.
- All network access is SSRF-guarded (no private ranges unless `--allow-private`, never cloud metadata).

## Development

```bash
npm install
npm run lint && npm run typecheck && npm test
npm run test:e2e          # also builds and runs generated Python servers (needs uv + network)
```

Packages: `packages/core` (discovery, intake, parsers, generator, templates), `packages/mcp-server`
(make-mcp as MCP server), `packages/cli` (`make-mcp` binary), `plugins/` (agent integrations).

Use the local build in Claude Code before a release:

```bash
npm run build
claude mcp add make-mcp-dev -- node "$PWD/packages/cli/dist/index.js" mcp
```

## Roadmap

- ~~M2: LLM-assisted API extraction from prose docs, grouping for large APIs, Python workspace detection~~ ✓
- ~~M3: local web UI and Docker image~~ ✓
- M4: Cloud Run deploy templates (Skaffold/Cloud Code)
- M5: community catalog of generator configs

## License

Apache-2.0
