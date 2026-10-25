# make-mcp for other coding agents

1. Add the MCP server to your agent, e.g. Cursor `.cursor/mcp.json`:

   ```json
   { "mcpServers": { "make-mcp": { "command": "npx", "args": ["-y", "make-mcp", "mcp"] } } }
   ```

   Codex (`~/.codex/config.toml`):

   ```toml
   [mcp_servers.make-mcp]
   command = "npx"
   args = ["-y", "make-mcp", "mcp"]
   ```

2. Optional guidance for the agent:
   - Cursor: copy `make-mcp.mdc` to `.cursor/rules/`
   - Codex and other AGENTS.md-aware agents: append `AGENTS.md` to your project's `AGENTS.md`

Clients that support MCP prompts can also start with the `create_mcp` prompt.
