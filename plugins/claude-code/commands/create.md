---
description: Generate an MCP server for a library, product or API – or "." for all libraries of the project (asks only what it cannot detect)
argument-hint: <package name, product, docs/OpenAPI URL, or "." for the whole project>
---

Create an MCP server for: $ARGUMENTS

Use the `make-mcp` skill and the make-mcp MCP tools. If no target was given, ask the user what the
server should be for (a package such as `daisyui`, a product name, a URL to docs, llms.txt or an OpenAPI spec, or `.`
for one server covering the libraries of the whole project).
