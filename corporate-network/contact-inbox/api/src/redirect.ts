// Where to send the browser after sign-in: same-site paths only.
const BASE = 'https://same-site.invalid';

// `next` if it is a path on this site, else `fallback`. It must start with exactly
// one "/" (not "//" or "/\", which browsers read as another host), contain no
// control characters, and resolve to this site's origin.
export function safeRedirect(next: unknown, fallback: string): string {
  if (typeof next !== 'string' || !/^\/(?![/\\])/.test(next) || /[\u0000-\u001f\u007f]/.test(next)) {
    return fallback;
  }
  try {
    const url = new URL(next, BASE);
    return url.origin === BASE ? url.pathname + url.search + url.hash : fallback;
  } catch {
    return fallback;
  }
}
