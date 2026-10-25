import semver from "semver";
import type { Fetcher } from "../fetch/types.js";
import type { ChangeEntry } from "../ir/index.js";
import { githubHeaders, repoWebUrl, type RepoRef } from "./repo-docs.js";

/**
 * Release notes for `changes_since`: GitHub releases of the package, or the sections of its CHANGELOG when the
 * project does not publish releases. Only stable versions unless the requested version is a pre-release itself.
 */

const VERSION = String.raw`(\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?)`;
const MAX_ENTRY_CHARS = 20_000;
const MAX_ENTRIES = 300;
const RELEASE_PAGES = 3;

function coerce(version: string): semver.SemVer | null {
  return semver.parse(version, { loose: true }) ?? semver.coerce(version, { includePrerelease: true });
}

/** Orders versions semantically ("2.10.0" after "2.9.1"); unparseable ones sort by their text. */
export function compareVersions(a: string, b: string): number {
  const va = coerce(a);
  const vb = coerce(b);
  // coerce() drops a fourth part ("1.2.3.10"), so ties fall back to a numeric text comparison.
  if (va && vb) return semver.compare(va, vb) || a.localeCompare(b, undefined, { numeric: true });
  return a.localeCompare(b, undefined, { numeric: true });
}

const isPrerelease = (version: string) => /[-](alpha|beta|rc|canary|next|dev|pre|insiders|experimental)|\d(a|b|rc|dev)\d/i.test(version);

/**
 * Version a release tag belongs to: `v1.2.3` and `1.2.3`, or – in monorepos – `pkg@1.2.3` / `pkg-v1.2.3` for this
 * package only. Returns `prefixed` so callers can drop plain tags of other packages' releases.
 */
export function tagVersion(tag: string, packageName?: string): { version: string; prefixed: boolean } | undefined {
  const plain = new RegExp(`^v?${VERSION}$`).exec(tag);
  if (plain) return { version: plain[1]!, prefixed: false };
  if (!packageName) return undefined;
  const scoped = new RegExp(`^(.+?)@v?${VERSION}$`).exec(tag);
  if (scoped && scoped[1] === packageName) return { version: scoped[2]!, prefixed: true };
  const dashed = new RegExp(`^(.+)-v${VERSION}$`).exec(tag);
  const base = packageName.split("/").pop();
  if (dashed && (dashed[1] === packageName || dashed[1] === base)) return { version: dashed[2]!, prefixed: true };
  return undefined;
}

interface GithubRelease {
  tag_name: string;
  name?: string | null;
  body?: string | null;
  draft?: boolean;
  published_at?: string | null;
  html_url: string;
}

/** GitHub answers 403/429 when the API rate limit is exhausted (60 requests per hour without a token). */
class RateLimited extends Error {}

async function githubReleases(repo: RepoRef, packageName: string | undefined, fetcher: Fetcher): Promise<ChangeEntry[]> {
  const found: (ChangeEntry & { prefixed: boolean })[] = [];
  for (let page = 1; page <= RELEASE_PAGES; page++) {
    const res = await fetcher(`https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=100&page=${page}`, {
      accept: "application/vnd.github+json",
      headers: githubHeaders(),
    });
    if (res.status === 403 || res.status === 429) throw new RateLimited(`GitHub API ${res.status}`);
    if (!res.ok) break;
    const releases = JSON.parse(res.body) as GithubRelease[];
    for (const release of releases) {
      const tag = tagVersion(release.tag_name, packageName);
      const body = (release.body ?? "").trim();
      if (!tag || release.draft || !body) continue;
      found.push({
        version: tag.version,
        title: release.name?.trim() || release.tag_name,
        ...(release.published_at ? { date: release.published_at.slice(0, 10) } : {}),
        markdown: body.slice(0, MAX_ENTRY_CHARS),
        sourceUrl: release.html_url,
        prefixed: tag.prefixed,
      });
    }
    if (releases.length < 100) break;
  }
  // A monorepo that tags this package's releases separately: plain tags belong to something else.
  const own = found.some((r) => r.prefixed) ? found.filter((r) => r.prefixed) : found;
  return own.map(({ prefixed: _prefixed, ...entry }) => entry);
}

/** Splits a Keep-a-Changelog/changesets style Markdown file into one entry per version heading. */
export function parseChangelog(markdown: string, sourceUrl: string): ChangeEntry[] {
  const heading = new RegExp(`^(#{1,3})\\s+\\[?v?${VERSION}\\]?(.*)$`, "gm");
  const hits = [...markdown.matchAll(heading)];
  if (hits.length === 0) return [];
  // Versions sit at one heading level; deeper version-like headings are sub-sections (e.g. "### 1.2 migration").
  const levels = new Map<number, number>();
  for (const h of hits) levels.set(h[1]!.length, (levels.get(h[1]!.length) ?? 0) + 1);
  const level = [...levels].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]![0];
  const sections = hits.filter((h) => h[1]!.length === level);

  return sections.map((h, i) => {
    const start = h.index! + h[0].length;
    const end = sections[i + 1]?.index ?? markdown.length;
    const date = /(\d{4}-\d{2}-\d{2})/.exec(h[3] ?? "")?.[1];
    return {
      version: h[2]!,
      title: h[2]!,
      ...(date ? { date } : {}),
      // Keep-a-Changelog link references ("[1.1.0]: https://…") at the end belong to no single release.
      markdown: markdown
        .slice(start, end)
        .replace(/(?:^\[[^\]]+\]:\s*\S+\s*$\n?)+$/m, "")
        .trim()
        .slice(0, MAX_ENTRY_CHARS),
      sourceUrl,
    };
  });
}

async function changelogFile(repo: RepoRef, packageName: string | undefined, fetcher: Fetcher): Promise<ChangeEntry[]> {
  const base = packageName?.split("/").pop();
  const candidates = [
    "CHANGELOG.md",
    ...(base ? [`packages/${base}/CHANGELOG.md`] : []),
    "HISTORY.md",
    "CHANGES.md",
    "docs/changelog.md",
    "docs/CHANGELOG.md",
  ];
  for (const file of candidates) {
    const res = await fetcher(`https://raw.githubusercontent.com/${repo.owner}/${repo.repo}/HEAD/${file}`, { accept: "text/markdown,text/plain" });
    if (!res.ok) continue;
    const entries = parseChangelog(res.body, `${repoWebUrl(repo)}/blob/HEAD/${file}`);
    if (entries.length > 0) return entries;
  }
  return [];
}

export interface LoadChangesOptions {
  /** The version the server is generated for; pre-releases are kept only if it is one. */
  version?: string;
}

export interface ChangesResult {
  entries: ChangeEntry[];
  /** The GitHub API refused (rate limit): releases may be missing – set GITHUB_TOKEN and try again. */
  rateLimited: boolean;
}

/** Release notes oldest first; no entries when the project publishes none we can read. Never throws for missing data. */
export async function loadChangesResult(
  repo: RepoRef,
  packageName: string | undefined,
  fetcher: Fetcher,
  options: LoadChangesOptions = {},
): Promise<ChangesResult> {
  let rateLimited = false;
  let entries = await githubReleases(repo, packageName, fetcher).catch((err: unknown) => {
    rateLimited = err instanceof RateLimited;
    return [] as ChangeEntry[];
  });
  if (entries.length === 0) entries = await changelogFile(repo, packageName, fetcher).catch(() => []);
  const keepPre = options.version !== undefined && isPrerelease(options.version);
  const seen = new Set<string>();
  const sorted = entries
    .filter((e) => keepPre || !isPrerelease(e.version))
    .filter((e) => !seen.has(e.version) && seen.add(e.version))
    .sort((a, b) => compareVersions(a.version, b.version))
    .slice(-MAX_ENTRIES);
  return { entries: sorted, rateLimited: rateLimited && entries.length === 0 };
}

export async function loadChanges(repo: RepoRef, packageName: string | undefined, fetcher: Fetcher, options: LoadChangesOptions = {}): Promise<ChangeEntry[]> {
  return (await loadChangesResult(repo, packageName, fetcher, options)).entries;
}
