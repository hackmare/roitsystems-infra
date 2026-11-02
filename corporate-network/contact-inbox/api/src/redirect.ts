// Where to send the browser after sign-in: same-site paths only.
const BASE = 'https://same-site.invalid';
const SAME_SITE_PATH = /^\/(?![/\\])/;

// `next` if it is a path on this site, else `fallback`. It must start with exactly
// one "/" (not "//" or "/\", which browsers read as another host), contain no
// control characters, and resolve to this site's origin. The resolved path is
// checked again: dot segments such as "/..//host" collapse to "//host".
export function safeRedirect(next: unknown, fallback: string): string {
  if (typeof next !== 'string' || !SAME_SITE_PATH.test(next) || /[\u0000-\u001f\u007f]/.test(next)) {
    return fallback;
  }
  try {
    const url = new URL(next, BASE);
    const path = url.pathname + url.search + url.hash;
    return url.origin === BASE && SAME_SITE_PATH.test(path) ? path : fallback;
  } catch {
    return fallback;
  }
}
