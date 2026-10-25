# Plan: make-mcp

**Source**: Konversation (Feature-Übersicht, Open-Source-Ausrichtung, Plugin + Intake), 2026-10-25
**Selected Milestone**: M1 – Core + Intake + Coding-Agent-Plugin + CLI (Testfälle: daisyUI, Petstore)
**Complexity**: Large (Gesamt), Medium–Large (M1)

## Summary
Open-Source-Generator, der aus API-Spezifikationen, Dokumentation **oder Quellcode** einen lauffähigen MCP-Server (TypeScript/Python) erzeugt. Primär als **Plugin für Coding-Agents** (Claude Code, Cursor, Codex, …): Der Agent führt ein kurzes Intake-Gespräch (Open Source? Code zugänglich? Doku? Version? …), ermittelt vorher alles automatisch Erkennbare und fragt nur die Lücken ab. Ziel: kostenpflichtige MCPs für frei verfügbare Software (Negativbeispiel: daisyUI) obsolet machen. Nutzer bringen eigenes LLM und eigene Rechenleistung mit.

## Leitprinzipien
1. **Bring your own compute/LLM** – kein zentraler Dienst; das LLM des Coding-Agents leistet die Analyse.
2. **Erst erkennen, dann fragen** – Version, Paket, Repo, Doku-URLs werden aus Workspace und Web ermittelt; gefragt wird nur, was fehlt oder unsicher ist.
3. **Ein Fragenkatalog für alle Agents** – Intake-Logik lebt deterministisch im Core, Agents rendern die Fragen nur (nativ, z. B. AskUserQuestion in Claude Code).
4. **Deterministisch vor LLM** – OpenAPI/Typdefinitionen ohne LLM; LLM nur für unstrukturierte Quellen.
5. **Laufzeit ohne LLM und (bei Docs-MCP) ohne Netz.**
6. **Zwei Modi, ein Kern** – `api` (Aktionen gegen eine API) und `docs` (Wissen über Bibliothek/Produkt), kombinierbar.

## Intake: Was immer geklärt wird

### Ablauf
```
1. Nutzer: "Bau mir einen MCP für daisyUI"
2. auto-detect   → Workspace (package.json/Lockfiles/pyproject/…), Registry (npm/PyPI), Repo, Doku-URLs, llms.txt, OpenAPI
3. next_questions → nur offene/unsichere Felder, jeweils mit erkanntem Vorschlag als Default
4. Agent fragt (nativ) → Antworten zurück an Core
5. plan_generation → Zusammenfassung zur Bestätigung ("Quelle: GitHub v5.0.x + llms.txt, Modus docs, TS, stdio, Projekt-scope")
6. generate + register → Server bauen, testen, im Agent eintragen
```

### Fragenkatalog (`IntakeAnswers`, zod-Schema im Core)
| # | Feld | Frage | Auto-Detect | Wirkung |
|---|---|---|---|---|
| 1 | `target` | Für welche Software/API soll der MCP sein? | Name aus Prompt, Paket im Workspace | Basis aller Suchen |
| 2 | `kind` | Was ist es? REST/GraphQL-API · Bibliothek/Framework/UI-Kit · CLI-Tool · internes System | npm/PyPI-Metadaten, OpenAPI-Fund | Modus-Vorschlag |
| 3 | `license` | **wird nicht gefragt** – nur still erkannt | Repo-/Registry-Lizenzfeld, `LICENSE`-Datei | Embed vs. Fetch-on-install, README-Hinweis, Publish-Gate (siehe Lizenz-Handling) |
| 4 | `codeSource` | Liegt der Code irgendwo im Zugriff? GitHub/GitLab-URL · lokaler Pfad · Paket (npm/PyPI) · nein | Registry `repository`-Feld, `node_modules/…`, `site-packages/…` | Quellcode als Quelle (Typen, Komponenten, Beispiele, `docs/`-Ordner) |
| 5 | `docsSource` | Gibt es eine Doku? URL · `llms.txt` · OpenAPI/Swagger · README · keine | Homepage aus Registry, `/llms.txt`, `/openapi.json` | Primärquelle |
| 6 | `version` | Welche Version? | Lockfile im Workspace, sonst `latest` aus Registry/Git-Tags | Snapshot-Version, Basis-URL/Pfade, Git-Ref |
| 7 | `mode` | Was soll der MCP können? Wissen nachschlagen · Aktionen ausführen · beides | aus `kind` | `docs` / `api` / `both` |
| 8 | `auth` | (nur `api`) Welche Authentifizierung? API-Key · Bearer · Basic · OAuth2 · keine | `securitySchemes` | Header + `.env.example` |
| 9 | `scope` | (nur bei großen APIs) Alles oder nur bestimmte Bereiche/Tags? | Anzahl Endpunkte | Filter/Gruppierung |
| 10 | `output` | Sprache (TS/Python), Transport (stdio/HTTP), Zielordner | Sprache des Workspace | Template-Wahl |
| 11 | `register` | Im Agent eintragen? Projekt · global · nein | erkannter Agent | `.mcp.json` / `claude mcp add` / `.cursor/mcp.json` / Codex-Config |

Regeln: Felder mit hoher Erkennungssicherheit werden nur in der Abschlusszusammenfassung bestätigt, nicht einzeln gefragt. Max. 4 Fragen pro Runde. `--yes`/nicht-interaktiv nimmt alle Defaults.

### Quellen-Priorität (pro Modus)
- **docs**: `llms-full.txt`/`llms.txt` → Doku im Repo (`docs/`, `*.md`, Beispiele) bei passendem Git-Tag → Doku-Website (Crawler) → Quellcode/Typdefinitionen → README
- **api**: OpenAPI/Swagger → Typdefinitionen offizieller SDKs → Markdown-Doku (LLM-Extraktion, M2)
- Paywall-/Login-geschützte Inhalte werden nie verwendet.

### Lizenz-Handling
1. **Still erkennen** – Lizenz (SPDX) aus Registry/Repo; Ergebnis in README des generierten Servers (Quelle, Version, Lizenz, Abrufdatum).
2. **Embed vs. Fetch-on-install** – Docs-Snapshot wird nur bei permissiver Lizenz (MIT, Apache-2.0, BSD, ISC, CC0, CC-BY*) eingebettet. Bei fehlender/unklarer/restriktiver Lizenz enthält der Server nur die Quellen-Config und lädt die Doku beim ersten Start bzw. per `refresh` lokal (Cache im User-Verzeichnis), danach offline.
3. **Publish-Gate** – `export --publish` (npm, Katalog) blockiert eingebettete Inhalte ohne permissive Lizenz und fällt auf Config-only zurück.
4. **Crawler-Etikette** – robots.txt und TDM-Vorbehalt (`tdm-reservation`, § 44b UrhG) werden respektiert; eigener User-Agent, Rate-Limit.

## Distribution
| Kanal | Inhalt | Milestone |
|---|---|---|
| **Claude-Code-Plugin** | Skill `make-mcp` (Intake-Ablauf, Fragen via AskUserQuestion) + Command `/make-mcp:create` + gebündelter MCP-Server (`.mcp.json`) | M1 |
| **Generischer MCP-Server** (Cursor, Codex, Windsurf, Claude Desktop …) | Gleiche Tools; Intake-Anleitung als MCP-Prompt `create_mcp` + Tool-Beschreibungen; Agent fragt konversationell | M1 |
| Agent-Regeln | `AGENTS.md`-Snippet, Cursor-Rule – verweisen auf MCP-Prompt | M1 |
| CLI `npx @make-mcp/cli create` | Gleicher Intake interaktiv im Terminal (`@inquirer/prompts`), `--yes` + Flags für CI | M1 |
| Lokale Web-UI + Docker | Formular auf Basis desselben Intake-Schemas | M3 |
| Cloud-Run-Deploy-Vorlagen (Skaffold/Cloud Code für Dev) | Für generierte HTTP-Server und die UI | M4 |
| Community-Katalog | Nur Intake-Antworten/Configs, keine kopierten Inhalte; Rebuild per GitHub Action | M5 |

## Delivery Milestones
| # | Milestone | Status | Plan |
|---|---|---|---|
| M0 | Repo-Setup, Tooling, CI | done | dieses Dokument |
| M1 | Core (IR, Discovery, Intake, Generator beide Modi) + MCP-Server + Claude-Code-Plugin + CLI | done (Live-Agent-Test offen) | dieses Dokument |
| M2 | LLM-Extraktion Markdown-API-Docs, Gruppierung großer APIs, Python-Templates vollständig, Python-Workspace-Detection | done | dieses Dokument (Abweichungen unten) |
| M3 | Lokale Web-UI + Docker-Image | done | `make-mcp ui` (token-geschützt, 127.0.0.1), Image `ghcr.io/make-mcp/make-mcp` (amd64/arm64) |
| M4 | Cloud-Run-Deploy-Vorlagen | done | `--transport http` → service.yaml (Knative, Secret Manager, minScale 0), skaffold.yaml (validiert mit Skaffold 2.25), README mit gcloud-Befehlen; Server verweigern öffentliches Binden ohne MCP_AUTH_TOKEN |
| M5 | Community-Katalog + Rebuild-Action, Plugin-Marketplace-Einträge | done | github.com/make-mcp/catalog (7 Einträge, Marketplace mit einem Plugin pro Eintrag, wöchentliche Validierung), `make-mcp run`/`catalog`, Katalog-Antworten als Intake-Vorgaben |

## Patterns to Mirror
Kein bestehender Code im Repo und keine vergleichbaren Projekte unter `~/Sites`. Konventionen werden **neu festgelegt** und gelten ab M0:

| Category | Festlegung |
|---|---|
| Naming | Dateien `kebab-case.ts`, Typen `PascalCase`, Funktionen `camelCase`; Packages `@make-mcp/<name>`; MCP-Tools `snake_case` |
| Errors | `MakeMcpError` mit `code` (`FETCH_BLOCKED`, `SPEC_INVALID`, `SOURCE_NOT_FOUND`, `INTAKE_INCOMPLETE`); im generierten Server HTTP-Fehler → Tool-Result `isError: true` |
| Logging | `pino`, JSON; im stdio-Modus **ausschließlich stderr** |
| Data access | Netz nur über `safe-fetch.ts`; Dateisystem nur über `workspace.ts` (read-only, auf Workspace-Root begrenzt) |
| Validation | `zod` für Intake, Config, CLI-Args, LLM-Outputs, IR |
| Tests | Vitest, `*.test.ts` neben der Quelle, Fixtures unter `fixtures/`, Snapshot-Tests für generierten Code |

## Architektur
```
packages/
  core/
    ir/          ApiSpec, Endpoint, AuthScheme, VersionStrategy, DocCorpus, DocPage
    intake/      IntakeAnswers-Schema, Findings (mit confidence), nextQuestions(), summarize()
    discover/    workspace (Lockfiles), registry (npm/PyPI), repo (GitHub/GitLab, Tags), docs (llms.txt, openapi, sitemap)
    fetch/       safe-fetch
    parse/       openapi, llms-txt, html-crawler, repo-docs, typescript-types
    generate/    api, docs
    export/      dir, zip, register (Agent-Configs)
  templates/   ts-api, ts-docs, py-api, py-docs (Eta)
  llm/         (M2) Provider-Abstraktion für CLI ohne Agent
  mcp-server/  make-mcp: Tools + Prompt create_mcp
  cli/         make-mcp (create, generate, mcp)
plugins/
  claude-code/ .claude-plugin/plugin.json, skills/make-mcp/SKILL.md, commands/create.md, .mcp.json
  agents-md/   AGENTS.md-Snippet, Cursor-Rule
fixtures/      petstore-v2.json, petstore-v3.yaml, daisyui/ (llms.txt-Auszug, Repo-Ausschnitt), workspaces/ (package.json+Lockfiles)
```

**MCP-Tools von make-mcp:** `detect_context` (Workspace + Ziel), `discover_sources`, `next_questions`, `submit_answers`, `preview_plan`, `generate_server`, `test_server` (Inspector-Smoke-Test), `register_server`.
**Transport generierter Server:** stdio + Streamable HTTP (SSE nur Legacy-Flag).

## Files to Change (M0 + M1)
| File | Action | Why |
|---|---|---|
| `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `vitest.workspace.ts` | CREATE | Monorepo |
| `LICENSE` (Apache-2.0), `README.md`, `CONTRIBUTING.md`, `.github/workflows/ci.yml` | CREATE | Open-Source-Basis + CI |
| `packages/core/src/ir/*.ts` | CREATE | Zwischenrepräsentation |
| `packages/core/src/intake/*.ts` | CREATE | Fragenkatalog, Lückenermittlung, Zusammenfassung |
| `packages/core/src/discover/*.ts` | CREATE | Auto-Erkennung Workspace/Registry/Repo/Doku |
| `packages/core/src/fetch/safe-fetch.ts`, `core/src/fs/workspace.ts` | CREATE | Sichere Netz-/Dateizugriffe |
| `packages/core/src/parse/*.ts` | CREATE | OpenAPI, llms.txt, Crawler, Repo-Docs, `.d.ts` |
| `packages/core/src/generate/*.ts`, `export/*.ts` | CREATE | Codegenerierung, Export, Registrierung |
| `packages/templates/**` | CREATE | TS-Templates voll, Python-Grundgerüst |
| `packages/mcp-server/src/**` | CREATE | Tools + Prompt |
| `packages/cli/src/**` | CREATE | Interaktiver/nicht-interaktiver Intake |
| `plugins/claude-code/**`, `plugins/agents-md/**` | CREATE | Agent-Integration |
| `fixtures/**` | CREATE | Testdaten |

## Tasks

### Task 1: Monorepo & CI (M0)
- **Action**: pnpm-Workspace, TS strict, ESLint, Vitest, GitHub-Actions-CI, Apache-2.0
- **Validate**: `pnpm i && pnpm lint && pnpm typecheck && pnpm test`

### Task 2: IR, safe-fetch, workspace
- **Action**: zod-IR; `safeFetch` (DNS→IP-Prüfung: RFC1918, Loopback, Link-Local, `169.254.169.254`, IPv6; ≤5 Redirects, 10 MB, 15 s); `workspace.ts` read-only mit Pfad-Begrenzung
- **Validate**: Tests für blockierte URLs/Redirects und Pfad-Traversal

### Task 3: Discovery
- **Action**: Workspace (package.json, package-lock/pnpm-lock/yarn.lock; pyproject/uv.lock/requirements in M2), npm/PyPI-Registry (Lizenz, Repo, Homepage, Versionen), Repo (Tags ↔ Version), Doku (`llms.txt`, `llms-full.txt`, `/openapi.json`, `/swagger.json`, Sitemap). Ergebnis: `Findings` mit `confidence` je Feld
- **Validate**: Fixture-Workspace mit `daisyui@5.x` → Version, Lizenz MIT, Repo-URL, llms.txt korrekt erkannt (Netz in Tests gemockt)

### Task 4: Intake-Logik
- **Action**: `nextQuestions(findings, answers)` liefert nur offene/unsichere Felder (≤4 pro Runde, mit Default + Optionen); bedingte Fragen (`auth`, `scope` nur bei `api`); `summarize()` für Bestätigung
- **Validate**: Tabellengetriebene Tests: daisyUI-Workspace → nur Fragen zu `mode`/`register`; leerer Workspace + Petstore-URL → `auth`, `output`, `register`

### Task 5: Parser
- **Action**: OpenAPI/Swagger → `ApiSpec`; llms.txt + Repo-Docs (Git-Tag der Version) + Crawler → `DocCorpus`; `.d.ts`-Exporte als Zusatzquelle
- **Validate**: Snapshots Petstore v2/v3; daisyUI-Fixture ergibt Komponentenseiten (`button`, `modal`, `card`) mit Code-Beispielen

### Task 6: Generatoren + TS-Templates
- **Action**: `api`: GET ohne Seiteneffekt → Ressource, sonst Tool; Auth aus ENV; `API_VERSION`/`API_BASE_URL` überschreibbar. `docs`: Snapshot (embedded oder fetch-on-install je Lizenz) + MiniSearch-Index; Tools `search_docs`, `get_page`, `list_topics`, ggf. `get_component`; Ressource je Seite. README mit Quelle, Version, Lizenzhinweis
- **Validate**: Beide Fixtures bauen; Inspector `tools/list`; daisyUI-Server beantwortet `search_docs("modal")` offline

### Task 7: Python-Templates (Grundgerüst)
- **Action**: `py-api`, `py-docs` mit FastMCP, gleiche Tool-Namen
- **Validate**: `uv run` + Inspector `tools/list` identisch zu TS

### Task 8: Export, Test, Registrierung
- **Action**: Ordner/ZIP; `test_server` startet generierten Server und prüft `tools/list`; `register` schreibt `.mcp.json` (Projekt) bzw. ruft `claude mcp add`, schreibt `.cursor/mcp.json` – nur nach Bestätigung, mit Diff-Anzeige
- **Validate**: Snapshot der Config-Änderungen; bestehende Einträge bleiben erhalten

### Task 9: MCP-Server (make-mcp)
- **Action**: Tools aus „Architektur“ + MCP-Prompt `create_mcp` mit Intake-Anleitung für Agents ohne Plugin-System
- **Validate**: Inspector-Durchlauf daisyUI end-to-end über Tool-Calls

### Task 10: Claude-Code-Plugin + Agent-Regeln
- **Action**: `plugin.json`, Skill mit Ablauf „detect → fragen (AskUserQuestion, Defaults vorbelegt) → Zusammenfassung bestätigen → generieren → testen → registrieren“; Command `/make-mcp:create [ziel]`; AGENTS.md-Snippet und Cursor-Rule
- **Validate**: Manueller Test in Claude Code: `/make-mcp:create daisyui` im Fixture-Workspace stellt ≤2 Fragen und registriert lauffähigen Server; gleicher Ablauf in Cursor über MCP-Prompt

### Task 11: CLI
- **Action**: `make-mcp create` (interaktiv, gleicher Intake), `generate` mit Flags/`--yes`, `mcp` (startet Server)
- **Validate**: E2E in CI nicht-interaktiv für Petstore und daisyUI

## Validation
```bash
npm install
npm run lint && npm run typecheck && npm test        # 97 Tests, startet generierte TS-Server per stdio
npm run test:e2e                                      # + generierte Python-Server via uv (Netz nötig)
npm run build
node packages/cli/dist/index.js generate --target daisyUI --workspace <projekt> --mode docs --yes
node packages/cli/dist/index.js test <projekt>/mcp-servers/daisyui-mcp
claude plugin validate plugins/claude-code && claude plugin validate .
```

## Abweichungen vom ursprünglichen Plan (M1)
| Geplant | Umgesetzt | Grund |
|---|---|---|
| pnpm | npm-Workspaces | pnpm nicht installiert; keine zusätzliche Toolchain nötig |
| `@apidevtools/swagger-parser` | eigener `$ref`-Resolver in `parse/openapi.ts` | zirkuläre Schemas JSON-sicher, eine Abhängigkeit weniger |
| 4 Templates (ts/py × api/docs) | 1 datengetriebene Laufzeit je Sprache (`templates/ts`, `templates/py`) | `both`-Modus ohne Duplikat; Laufzeit ist typgeprüft und unabhängig vom Generator |
| `.d.ts`-Exporte als Quelle | nach M2 verschoben | Doku-Quellen decken daisyUI/Petstore vollständig ab |
| `register` ruft `claude mcp add` | globaler Scope liefert nur den Befehl | keine ungefragten Änderungen an User-Configs |
| Fragen `kind`, `license` | still erkannt, nicht gefragt | weniger Rückfragen (daisyUI: 2, Petstore: 2) |
| — | `local-docs`-Quelle (lokaler Checkout) | deckt „Code liegt lokal“ aus dem Intake ab |
| M2: `llm/`-Paket mit Provider-Abstraktion | `core/src/extract/` (prose-api + schlanker LLM-Client ohne SDK, nur CLI) | im Agent-Modus extrahiert das Agent-LLM über `extract_api`/`submit_extraction`; kein Key, keine Zusatzabhängigkeit |
| M2: Halluzinationsschutz „Review im Intake“ | jede Operation braucht ein wörtliches Zitat; Zitat, Pfad und Methode werden gegen die zitierte Seite geprüft | deterministisch statt nur Sichtprüfung; abgelehnte Operationen werden mit Grund gemeldet |
| M2: Gruppierung per Tags | drei Meta-Tools (`list_operations`/`describe_operation`/`call_operation`) ab 40 Operationen, `--tools` zum Übersteuern | skaliert auf beliebig große APIs, keine zusätzliche Intake-Frage |
| M2: Python-Templates | BM25-Suche, Legacy-SSE, `--refresh` (delegiert an `npx @make-mcp/cli refresh`) | Laufzeit bleibt abhängigkeitsfrei; Doku-Loader existiert nur einmal (TS) |

## Risks
| Risk | Likelihood | Mitigation |
|---|---|---|
| Zu viele Fragen nerven | Mittel | Auto-Detect zuerst, ≤4 Fragen/Runde, Defaults, nur Zusammenfassung bei hoher Sicherheit |
| Falsch erkannte Version (z. B. Monorepo, mehrere Lockfiles) | Mittel | `confidence` + Quelle anzeigen; bei Konflikt immer fragen |
| SSRF / Dateizugriff außerhalb Workspace | Mittel | `safeFetch`, `workspace.ts`, Tests |
| Agent schreibt ungefragt in Agent-Configs | Mittel | `register` nur nach Bestätigung, Diff zeigen, nie überschreiben |
| Unterschiedliche Plugin-Systeme der Agents | Mittel | Logik im MCP-Server; Plugins sind dünne Hüllen |
| Urheberrecht an Doku-Inhalten | Mittel | Lizenz still erkennen; Embed nur bei permissiver Lizenz, sonst Fetch-on-install; Publish-Gate; robots.txt/TDM respektieren; keine Paywall-Inhalte |
| LLM erfindet Endpunkte (Markdown-APIs, M2) | Hoch | Hybrid, Quellenzitat, Review im Intake-Schritt `preview_plan` |
| Zu viele Tools bei großen APIs | Mittel | Intake-Feld `scope`, Gruppierung M2 |
| Abgrenzung zu Context7/GitMCP | Mittel | README: versionsgenau aus Workspace, offline, API+Docs, Code exportierbar |
| MCP-/Plugin-API-Änderungen | Niedrig | Versionen pinnen, Template- und Plugin-Smoke-Tests in CI |

## Acceptance (M1)
- [x] daisyUI: Version aus Lockfile erkannt, 2 Rückfragen, generiert, getestet, registriert – über MCP-Tools (In-Memory-Client) und CLI verifiziert; live gegen npm/GitHub/daisyui.com: 82 Seiten, 68 Komponenten, `npm install`+Build+Start ok
- [ ] `/make-mcp:create daisyui` interaktiv in einer echten Claude-Code-Session (benötigt npm-Publish oder lokale MCP-Registrierung)
- [ ] Gleicher Ablauf in Cursor über MCP-Prompt `create_mcp` (manuell)
- [x] Petstore → TS- und Python-API-MCP bauen und listen identische Tools
- [x] daisyUI-Docs-MCP beantwortet `search_docs`/`get_component` offline (TS + Python)
- [x] Kein eigener API-Key nötig; CLI läuft nicht-interaktiv (`generate --yes`)
- [x] SSRF-/Pfad-/robots-/TDM-Tests grün; Lint + Typecheck grün; CI-Workflow angelegt (noch nicht auf GitHub gelaufen)
