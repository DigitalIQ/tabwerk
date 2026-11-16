// Nur die Google-Suche, keine beliebigen Websites oder Google-Dienste.
export const GOOGLE_SEARCH_HOSTS = ['www.google.com', 'www.google.de', 'www.google.at', 'www.google.ch'];
export const GOOGLE_SEARCH_ORIGINS = GOOGLE_SEARCH_HOSTS.map((host) => `https://${host}/*`);
export const GOOGLE_SEARCH_MATCHES = GOOGLE_SEARCH_HOSTS.map((host) => `https://${host}/search*`);

export function isGoogleSearch(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && !parsed.port && GOOGLE_SEARCH_HOSTS.includes(parsed.hostname) && parsed.pathname === '/search';
  } catch { return false; }
}
