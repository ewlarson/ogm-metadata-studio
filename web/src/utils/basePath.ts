const rawBaseUrl = import.meta.env.BASE_URL || "/";

function normalizedBasePath(): string {
  if (rawBaseUrl === "/") return "";
  return rawBaseUrl.endsWith("/") ? rawBaseUrl.slice(0, -1) : rawBaseUrl;
}

export function withBasePath(path: string): string {
  if (/^(?:[a-z]+:)?\/\//i.test(path)) return path;

  const base = normalizedBasePath();
  if (!base) return path;

  if (path === "/") return `${base}/`;
  if (path.startsWith(base + "/") || path === base) return path;
  if (path.startsWith("/")) return `${base}${path}`;

  return `${base}/${path}`;
}

export function stripBasePath(pathname: string): string {
  const base = normalizedBasePath();
  if (!base) return pathname || "/";
  if (pathname === base || pathname === `${base}/`) return "/";
  if (pathname.startsWith(`${base}/`)) return pathname.slice(base.length) || "/";
  return pathname || "/";
}
