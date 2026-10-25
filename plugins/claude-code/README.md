# make-mcp – Claude Code plugin

Generate an MCP server for any library, product or API from its own documentation (`llms.txt`, docs site, OpenAPI
spec, repository docs) – for the exact version in your project's lockfile.

```
/make-mcp:create daisyui
```

…or just ask Claude for "an MCP server for <library>". The plugin contains:

- **Skill `make-mcp`** and **command `/make-mcp:create`** – the guided flow: detect → ask only what is unknown →
  confirm → generate → test → register (the config diff is shown before anything is written).
- **MCP server `make-mcp`** – started with `npx -y @make-mcp/cli@<version> mcp`; tools `detect_context`,
  `submit_answers`, `preview_plan`, `extract_api`, `submit_extraction`, `generate_server`, `test_server`,
  `register_server`.

## What it reads, writes and contacts

make-mcp runs locally; there is no make-mcp service, no account and no telemetry.

| Destination | Why |
|---|---|
| `registry.npmjs.org` | starting the MCP server via `npx`; package metadata (version, license, repository) of the target |
| `pypi.org` | metadata of Python targets |
| `api.github.com`, `raw.githubusercontent.com` | repository tags and docs of the target; community catalog entries (`github.com/make-mcp/catalog`) |
| the target's own documentation site | `llms.txt`, `llms-full.txt`, OpenAPI spec or docs pages – respecting robots.txt and TDM reservations |

Your project files are only read (package.json, lockfiles, pyproject.toml …) to detect the version. Files are written
only to the output folder you confirm (default `mcp-servers/<name>-mcp`) and, after you approve the diff, to
`.mcp.json` / `.cursor/mcp.json`. Generated servers are tested by installing their dependencies (`npm install` or
`uv sync`). If an API has no OpenAPI spec, the extraction is done by Claude itself – no other model, no API key.

Source and docs: https://github.com/make-mcp/make-mcp · https://make-mcp.net · License: Apache-2.0
