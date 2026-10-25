---
name: make-mcp
description: Generate a local MCP server for a library, framework, UI kit, product or REST API from its documentation, llms.txt, OpenAPI/Swagger spec or source code. Use when the user wants an MCP server, "a MCP for X", wants docs of a dependency available to the agent, or wants to replace a paid MCP for a freely available tool.
---

# make-mcp

Builds MCP servers with the `make-mcp` MCP tools. Detection happens first, so you only ask the user what
cannot be found automatically. Speak the user's language; tool output is English.

## Workflow

1. **Detect** – call `detect_context` with the target the user named and always pass `workspace` = the absolute
   path of the user's project (the server's working directory may differ). Briefly tell the user what was found
   (version and where it came from, license, docs source, repository) and mention every entry in `notes`.
2. **Ask** – for the returned `questions`, use `AskUserQuestion` (at most 4 per call):
   - `header` → question header, `question` → question text
   - `options` → options (`label`, `description`); put the option whose `value` equals `default` first and add
     "(Recommended)" to its label
   - `allowFreeText: true` means the user may type a URL, path or version via "Other"
   Never answer questions on the user's behalf.
3. **Submit** – call `submit_answers` with `{ "<question id>": "<value or label>" }`. Repeat steps 2–3 while
   `questions` is not empty.
4. **Confirm** – call `preview_plan`, show the summary unchanged, and ask for explicit confirmation.
   Do not generate without a clear yes.
5. **Generate & test** – call `generate_server`, then `test_server` with the same `sessionId`. Report the tools,
   warnings (e.g. docs that are downloaded on install because the license does not allow embedding) and
   any test failure verbatim.
6. **Register** – call `register_server` without `apply` and show the user the resulting config change or command.
   Only call it again with `apply: true` after the user agreed. For global scope, give the user the command to run
   (suggest the `!` prefix). Remind them to set the listed credential environment variables, never ask for secret
   values in chat.

## Rules

- Prefer what detection found over guesses; if detection is wrong, let the user correct it via the questions.
- Content behind logins or paywalls is never used. robots.txt and TDM reservations are honoured by the tools.
- If a step fails with `SOURCE_NOT_FOUND`, ask the user for a docs/spec URL or a code location and submit it as
  `docsSource` / `codeSource`.
