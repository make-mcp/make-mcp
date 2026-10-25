import type { Fetcher } from "../fetch/types.js";
import { normalizePythonName } from "./python-packages.js";

export interface PackageMetadata {
  registry: "npm" | "pypi";
  name: string;
  version: string;
  latest: string;
  description?: string;
  license?: string;
  repositoryUrl?: string;
  homepage?: string;
  docsUrl?: string;
}

interface NpmManifest {
  name: string;
  version: string;
  description?: string;
  license?: string | { type?: string };
  repository?: string | { url?: string };
  homepage?: string;
}

function npmLicense(license: NpmManifest["license"]): string | undefined {
  return typeof license === "string" ? license : license?.type;
}

/** Fetches npm metadata for an exact version (falls back to `latest`). Uses the small per-version documents. */
export async function npmMetadata(name: string, version: string | undefined, fetcher: Fetcher): Promise<PackageMetadata | undefined> {
  const base = `https://registry.npmjs.org/${name.replace("/", "%2F")}`;
  const latestRes = await fetcher(`${base}/latest`, { accept: "application/json" });
  if (!latestRes.ok) return undefined;
  const latest = JSON.parse(latestRes.body) as NpmManifest;

  let manifest = latest;
  if (version && version !== latest.version && /^\d/.test(version)) {
    const res = await fetcher(`${base}/${encodeURIComponent(version)}`, { accept: "application/json" });
    if (res.ok) manifest = JSON.parse(res.body) as NpmManifest;
  }

  const repository = typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url;
  const license = npmLicense(manifest.license);
  return {
    registry: "npm",
    name: manifest.name,
    version: manifest.version,
    latest: latest.version,
    ...(manifest.description ? { description: manifest.description } : {}),
    ...(license ? { license } : {}),
    ...(repository ? { repositoryUrl: repository } : {}),
    ...(manifest.homepage ? { homepage: manifest.homepage.replace(/#.*$/, "") } : {}),
  };
}

interface PypiInfo {
  info: {
    name: string;
    version: string;
    summary?: string;
    license?: string;
    license_expression?: string;
    home_page?: string;
    project_urls?: Record<string, string> | null;
  };
}

export async function pypiMetadata(name: string, version: string | undefined, fetcher: Fetcher): Promise<PackageMetadata | undefined> {
  const project = encodeURIComponent(normalizePythonName(name));
  const latestRes = await fetcher(`https://pypi.org/pypi/${project}/json`, { accept: "application/json" });
  if (!latestRes.ok) return undefined;
  const latest = JSON.parse(latestRes.body) as PypiInfo;
  let data = latest;
  if (version && version !== latest.info.version) {
    const res = await fetcher(`https://pypi.org/pypi/${project}/${encodeURIComponent(version)}/json`);
    if (res.ok) data = JSON.parse(res.body) as PypiInfo;
  }

  const urls = Object.fromEntries(Object.entries(data.info.project_urls ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  const repositoryUrl = urls.source ?? urls.repository ?? urls["source code"] ?? Object.values(urls).find((u) => /github\.com/.test(u));
  const license = data.info.license_expression ?? (data.info.license && data.info.license.length < 40 ? data.info.license : undefined);
  const homepage = urls.homepage ?? data.info.home_page ?? undefined;
  const docsUrl = urls.documentation ?? urls.docs;
  return {
    registry: "pypi",
    name: data.info.name,
    version: data.info.version,
    latest: latest.info.version,
    ...(data.info.summary ? { description: data.info.summary } : {}),
    ...(license ? { license } : {}),
    ...(repositoryUrl ? { repositoryUrl } : {}),
    ...(homepage ? { homepage } : {}),
    ...(docsUrl ? { docsUrl } : {}),
  };
}
