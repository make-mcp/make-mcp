## Generating MCP servers (make-mcp)

When the user asks for an MCP server for a library, product or API, use the `make-mcp` MCP server
(`npx -y @make-mcp/cli mcp`). Its `create_mcp` prompt and tool descriptions contain the full workflow:

1. `detect_context` with the target and `workspace` = absolute project path → report what was found, including `notes`.
2. Ask the returned `questions` (show options, pre-select `default`, allow free text when `allowFreeText`).
   Never answer on the user's behalf.
3. `submit_answers` until no questions remain.
4. `preview_plan` → show the summary, wait for an explicit yes.
   If it asks for an extraction (API without OpenAPI spec): `extract_api` → extract the operations yourself as JSON
   following its instructions and schema (verbatim quotes, nothing invented) → `submit_extraction`, for every task.
5. `generate_server`, then `test_server`.
6. `register_server` without `apply`, show the diff; apply only after the user agrees.
Never ask for secret values in chat; tell the user which environment variables to set.
