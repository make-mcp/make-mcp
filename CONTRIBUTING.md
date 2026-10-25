# Contributing

1. `npm install`, then `npm run lint && npm run typecheck && npm test` must pass.
2. Tests live next to the code (`*.test.ts`, Vitest). Network access in tests goes through
   `createFixtureFetch` – add fixtures under `fixtures/http` and register them in `manifest.json`.
3. All network access in core uses a `Fetcher` (`createSafeFetch` / `createPoliteFetch`). Do not call `fetch` directly.
4. Errors are `MakeMcpError` with a code; add new codes to `packages/core/src/errors.ts`.
5. The generated server runtimes (`packages/core/templates/ts/src/index.ts`, `templates/py/server.py`) must stay
   free of generator dependencies. Keep TS and Python behaviour (tool names, resource URIs) identical –
   `npm run test:e2e` checks both.
6. Only add documentation sources that are publicly accessible; never bypass robots.txt, TDM reservations or logins.

## Releasing

1. `npm run set-version -- 0.2.0 && npm install` – updates every pinned version (packages, internal
   dependencies, runtime constants, Claude Code plugin) and the lockfile.
2. Commit, then `git tag v0.2.0 && git push --follow-tags`.
3. The `Release` workflow tests everything and publishes `@make-mcp/core`, `@make-mcp/mcp-server` and
   `@make-mcp/cli` via npm trusted publishing (no token).
