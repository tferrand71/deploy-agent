/**
 * Analyse d'une ligne du journal d'accès Traefik.
 * Deux formats : JSON (actuel, avec en-têtes utiles) et CLF (historique,
 * sans navigateur ni provenance), pour reprendre les journaux existants.
 */

export type RawHit = {
  ip: string;
  host: string | null; // null : routeur à résoudre via les labels Docker (CLF)
  router: string | null;
  path: string;
  query: string;
  method: string;
  status: number;
  bytes: number;
  durationMs: number;
  userAgent: string | null; // null = inconnu (format CLF)
  referer: string | null;
  fetchDest: string | null;
  rsc: boolean;
  prefetch: boolean;
  hasHeaders: boolean;
};

function header(obj: Record<string, unknown>, name: string): string | null {
  const wanted = `request_${name}`.toLowerCase();
  for (const [k, v] of Object.entries(obj)) {
    if (k.toLowerCase() === wanted && typeof v === "string" && v !== "") return v;
  }
  return null;
}

function splitPath(raw: string): { path: string; query: string } {
  const i = raw.indexOf("?");
  return i === -1 ? { path: raw, query: "" } : { path: raw.slice(0, i), query: raw.slice(i + 1) };
}

function routerName(raw: unknown): string | null {
  if (typeof raw !== "string" || raw === "" || raw === "-") return null;
  return raw.replace(/@.*$/, "");
}

function parseJson(line: string): RawHit | null {
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof o.RequestMethod !== "string" || typeof o.DownstreamStatus !== "number") return null;

  const { path, query } = splitPath(String(o.RequestPath ?? "/"));
  const host = typeof o.RequestHost === "string" ? o.RequestHost.split(":")[0] : null;
  return {
    ip: String(o.ClientHost ?? ""),
    host,
    router: routerName(o.RouterName),
    path,
    query,
    method: o.RequestMethod,
    status: o.DownstreamStatus,
    bytes: Number(o.DownstreamContentSize ?? 0),
    durationMs: Math.round(Number(o.Duration ?? 0) / 1e6),
    userAgent: header(o, "User-Agent"),
    referer: header(o, "Referer"),
    fetchDest: header(o, "Sec-Fetch-Dest"),
    rsc: header(o, "Rsc") === "1",
    prefetch: header(o, "Next-Router-Prefetch") !== null,
    hasHeaders: true,
  };
}

// 1.2.3.4 - - [19/Oct/2026:10:59:48 +0000] "GET /x HTTP/2.0" 200 179 "-" "-" 35239 "coloc@docker" "http://…" 74ms
const CLF =
  /^(\S+) \S+ \S+ \[[^\]]+\] "(\S+) (\S+)[^"]*" (\d{3}) (\d+|-) "([^"]*)" "([^"]*)" \d+ "([^"]*)" "[^"]*" (\d+)ms/;

function parseClf(line: string): RawHit | null {
  const m = line.match(CLF);
  if (!m) return null;
  const { path, query } = splitPath(m[3]);
  return {
    ip: m[1],
    host: null,
    router: routerName(m[8]),
    path,
    query,
    method: m[2],
    status: Number(m[4]),
    bytes: m[5] === "-" ? 0 : Number(m[5]),
    durationMs: Number(m[9]),
    userAgent: m[7] === "-" ? null : m[7],
    referer: m[6] === "-" ? null : m[6],
    fetchDest: null,
    rsc: /(^|&)_rsc=/.test(query),
    prefetch: false,
    hasHeaders: false,
  };
}

export function parseLine(line: string): RawHit | null {
  return line.startsWith("{") ? parseJson(line) : parseClf(line);
}

/* ── Classification ─────────────────────────────────────────── */

const BOT_UA =
  /bot|crawl|spider|slurp|curl|wget|python|go-http|httpclient|java\/|okhttp|headless|monitor|scan|preview|facebookexternalhit|axios|node-fetch|undici|uptime|lighthouse|pingdom|zgrab|masscan|nmap/i;

// Sondes de vulnérabilités : un humain ne demande pas /.env ni /wp-login.php
const PROBE = /\.(php\d?|env|git|aspx?|jsp|cgi|ini|bak|sql)(\/|$)|wp-|phpmyadmin|\.\.|\/\.|cgi-bin|xmlrpc/i;

export function isBot(hit: RawHit): boolean {
  if (PROBE.test(hit.path)) return true;
  if (hit.hasHeaders && !hit.userAgent) return true;
  return hit.userAgent !== null && BOT_UA.test(hit.userAgent);
}

const ASSET_PREFIX = /^\/(_next|api|uploads|icons|images|static|fonts|\.well-known)\//;
const ASSET_FILE = /\.(?!html?$)[a-z0-9]{1,5}$/i;

/** Une page réellement affichée : chargement complet ou navigation Next.js (pas un préchargement). */
export function isPageview(hit: RawHit, bot: boolean): boolean {
  if (bot || hit.method !== "GET") return false;
  if (!((hit.status >= 200 && hit.status < 300) || hit.status === 304)) return false;
  if (ASSET_PREFIX.test(hit.path) || ASSET_FILE.test(hit.path)) return false;
  if (/^\/(favicon|sw\.js|manifest|robots\.txt|sitemap)/.test(hit.path)) return false;

  if (hit.fetchDest === "document") return true;
  if (hit.rsc) return !hit.prefetch && hit.hasHeaders;
  if (hit.fetchDest) return false; // fetch/script/image… : pas une page
  return true; // pas d'en-tête Sec-Fetch : vieux navigateur ou journal historique
}

/* ── Agent utilisateur → navigateur / OS / appareil ──────────── */

export function parseUserAgent(ua: string | null): { browser: string | null; os: string | null; device: string | null } {
  if (!ua) return { browser: null, os: null, device: null };

  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /OPR\/|Opera/.test(ua)
      ? "Opera"
      : /SamsungBrowser/.test(ua)
        ? "Samsung Internet"
        : /Firefox\/|FxiOS/.test(ua)
          ? "Firefox"
          : /Chrome\/|CriOS/.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : "Autre";

  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /CrOS/.test(ua)
          ? "ChromeOS"
          : /Mac OS X|Macintosh/.test(ua)
            ? "macOS"
            : /Linux/.test(ua)
              ? "Linux"
              : "Autre";

  const device = /iPad|Tablet|Android(?!.*Mobile)/.test(ua)
    ? "Tablette"
    : /Mobi|iPhone|iPod/.test(ua)
      ? "Mobile"
      : "Ordinateur";

  return { browser, os, device };
}

/** Domaine d'origine, ou null pour une navigation interne / sans provenance. */
export function referrerHost(referer: string | null, host: string): string | null {
  if (!referer) return null;
  try {
    const h = new URL(referer).hostname.replace(/^www\./, "");
    return h === host ? null : h;
  } catch {
    return null;
  }
}
