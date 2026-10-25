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

1. `npm run set-version -- <version> && npm install` – updates every pinned version (packages, internal
   dependencies, runtime constants, Claude Code plugin) and the lockfile.
2. Commit, then `git tag v<version> && git push --follow-tags`.
3. The `Release` workflow tests everything and publishes the packages via npm trusted publishing (no token); the
   `Docker` workflow pushes `ghcr.io/make-mcp/make-mcp:<version>` and `latest`. npm stages new versions for a few
   minutes, so a re-run reports them as already published – that is expected.
4. Trusted publishing currently works for `@make-mcp/core` only. Until it does for the other two, publish them by hand
   after the workflow: `npm ci && npm run build && npm publish -w @make-mcp/mcp-server && npm publish -w @make-mcp/cli`.
   The Claude Code plugin pins `@make-mcp/cli@<version>`, so it fails to start until that is done.
