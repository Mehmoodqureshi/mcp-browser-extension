import { normalizeDomainPattern } from './policy';

/** Only named HTTP(S) sites may be requested; never a catch-all or a file URL. */
export function siteOrigins(input: string): string[] {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input) && !/^https?:\/\//i.test(input)) return [];
  const pattern = normalizeDomainPattern(input);
  const host = pattern.startsWith('*.') ? pattern.slice(2) : pattern;
  if (!host || host.length > 253 ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(host)) return [];
  return [`http://${pattern}/*`, `https://${pattern}/*`];
}

/** Match patterns have no port or path scope for host permissions. */
export function originForUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? `${parsed.protocol}//${parsed.hostname}/*` : null;
  } catch { return null; }
}

export function isGlobalOrigin(origin: string): boolean {
  return origin === '<all_urls>' || /^(?:\*|[a-z]+):\/\/\*\/.*$/i.test(origin);
}

export const OPTIONAL_FEATURES = {
  cookies: { label: 'Cookies', explanation: 'Read cookies on websites you have allowed. Cookie values still follow your server settings.' },
  downloads: { label: 'Downloads', explanation: 'Save files from websites you have allowed.' },
} as const;
export type OptionalFeature = keyof typeof OPTIONAL_FEATURES;
export const FEATURE_REQUESTS_KEY = 'browserPermissionRequests';
export const PERMISSIONS_MIGRATION_KEY = 'optionalBrowserPermissionsV1';
export const PROXY_AUTH_PERMISSIONS = ['webRequest', 'webRequestAuthProvider'];
export const IP_LOOKUP_ORIGINS = ['https://ipinfo.io/*', 'https://api.ipify.org/*'];
