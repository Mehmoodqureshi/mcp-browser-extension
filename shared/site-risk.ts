/** Local warning rules. An empty result means no rule matched, never a safety guarantee. */
export const SITE_CHECKS_KEY = 'localSiteChecksV1';
export const SITE_CHECKS_PENDING_KEY = 'localSiteWarnings';
export const SITE_CHECKS_APPROVALS_KEY = 'localSiteWarningApprovals';
export const SITE_CHECKS_BLOCKED_KEY = 'localBlockedSites';
export const AUTOMATIC_SITE_ORIGINS = ['http://*/*', 'https://*/*'];

export interface SiteWarning { id: string; reason: string }
export interface SiteWarningRequest { origin: string; host: string; warnings: SiteWarning[]; at: number }
export interface LoginSignals {
  url: string;
  title: string;
  passwords: number;
  forms: Array<{ action: string; method: string }>;
}

const BRANDS: Record<string, string[]> = {
  google: ['google.com', 'google.co.uk', 'google.com.pk', 'google.de', 'google.fr', 'google.co.in', 'google.com.au', 'google.ca', 'google.co.jp', 'youtube.com'],
  microsoft: ['microsoft.com', 'microsoftonline.com', 'live.com', 'office.com', 'outlook.com'],
  apple: ['apple.com', 'icloud.com'],
  paypal: ['paypal.com'],
  amazon: ['amazon.com', 'amazon.co.uk', 'amazon.de', 'amazon.fr', 'amazon.in', 'amazon.ca', 'amazon.com.au', 'amazon.co.jp', 'amazon.es', 'amazon.it'],
  github: ['github.com', 'github.dev'],
  facebook: ['facebook.com', 'meta.com'],
  instagram: ['instagram.com', 'meta.com'],
  linkedin: ['linkedin.com'],
  dropbox: ['dropbox.com'],
  coinbase: ['coinbase.com'],
};
const AUTH_WORD = /(?:^|[.\-])(login|signin|sign-in|verify|verification|secure|account|password|recover|support)(?:[.\-]|$)/;

function hostIn(host: string, domains: string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** RFC 3492 decoding, bounded by DNS label length. Invalid labels remain unchanged. */
function unicodeLabel(label: string): string {
  if (!label.startsWith('xn--') || label.length > 63) return label;
  try {
    const input = label.slice(4);
    const split = input.lastIndexOf('-');
    const points = split < 0 ? [] : Array.from(input.slice(0, split), (c) => c.codePointAt(0)!);
    let pos = split < 0 ? 0 : split + 1;
    let n = 128, i = 0, bias = 72;
    while (pos < input.length) {
      const old = i;
      let weight = 1;
      for (let k = 36; ; k += 36) {
        const code = input.charCodeAt(pos++);
        const digit = code >= 97 && code <= 122 ? code - 97 : code >= 48 && code <= 57 ? code - 22 : 36;
        if (digit >= 36 || !Number.isSafeInteger(i + digit * weight)) return label;
        i += digit * weight;
        const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
        if (digit < t) break;
        weight *= 36 - t;
      }
      const size = points.length + 1;
      let delta = Math.floor((i - old) / (old === 0 ? 700 : 2));
      delta += Math.floor(delta / size);
      let k = 0;
      while (delta > 455) { delta = Math.floor(delta / 35); k += 36; }
      bias = k + Math.floor(36 * delta / (delta + 38));
      n += Math.floor(i / size);
      i %= size;
      if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return label;
      points.splice(i++, 0, n);
    }
    return String.fromCodePoint(...points);
  } catch { return label; }
}

/** A deliberately small confusable set for these rules, not a full Unicode classifier. */
function skeleton(label: string): string {
  const lookalikes: Record<string, string> = {
    'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x',
    'і': 'i', 'ј': 'j', 'ӏ': 'l', 'ѕ': 's', 'ԁ': 'd', 'ԛ': 'q',
    'α': 'a', 'ο': 'o', 'ρ': 'p', 'ν': 'v', 'ι': 'i', '0': 'o', '1': 'l',
  };
  return Array.from(unicodeLabel(label).toLowerCase(), (c) => lookalikes[c] ?? c).join('');
}

export function isLocalDevelopmentHost(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost') || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
}

export function siteUrlWarnings(input: string): SiteWarning[] {
  let url: URL;
  try { url = new URL(input); } catch { return []; }
  if (!/^https?:$/.test(url.protocol)) return [];
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const warnings: SiteWarning[] = [];
  if (url.username && /[.]/.test(decodeURIComponentSafe(url.username))) {
    warnings.push({ id: 'hidden-destination', reason: `The address puts a website name before @. The actual destination is ${host}.` });
  }
  const labels = host.split('.');
  for (const [brand, domains] of Object.entries(BRANDS)) {
    if (hostIn(host, domains)) continue;
    if (domains.some((domain) => host.includes(`${domain}.`))) {
      warnings.push({ id: `misleading-domain:${brand}`, reason: `The address includes ${brand}'s domain but actually belongs to ${host}.` });
      continue;
    }
    if (labels.some((label) => label !== brand && skeleton(label) === brand)) {
      warnings.push({ id: `lookalike:${brand}`, reason: `The address uses lookalike characters to resemble ${brand}.` });
      continue;
    }
    // A brand in an article path or an ordinary unrelated domain is not enough.
    if (labels.some((label) => label.split('-').includes(brand)) && AUTH_WORD.test(host)) {
      warnings.push({ id: `brand-login:${brand}`, reason: `The address combines ${brand}'s name with login or account wording outside its recognised domains.` });
    }
  }
  return warnings;
}

function decodeURIComponentSafe(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

export function loginWarnings(signals: LoginSignals): SiteWarning[] {
  const warnings = siteUrlWarnings(signals.url);
  if (!signals.passwords) return warnings;
  let page: URL;
  try { page = new URL(signals.url); } catch { return warnings; }
  if (!/^https?:$/.test(page.protocol)) return warnings;
  const local = isLocalDevelopmentHost(page.hostname);
  if (page.protocol === 'http:' && !local) warnings.push({
    id: 'unencrypted-login', reason: 'This page asks for a password over an unencrypted HTTP connection.',
  });
  for (const form of signals.forms.slice(0, 32)) {
    let action: URL;
    try { action = new URL(form.action || signals.url, signals.url); } catch { continue; }
    if (action.protocol === 'http:' && !(local && isLocalDevelopmentHost(action.hostname))) warnings.push({
      id: `unencrypted-password-destination:${action.origin}`, reason: `A password form sends to an unencrypted address at ${action.hostname}.`,
    });
    if (form.method === 'get') warnings.push({
      id: 'password-in-address', reason: 'A password form is configured to put its fields in the website address.',
    });
  }
  const title = signals.title.slice(0, 300).toLowerCase();
  if (/\b(sign[ -]?in|log[ -]?in|verify|account|password)\b/.test(title)) {
    for (const [brand, domains] of Object.entries(BRANDS)) {
      if (new RegExp(`\\b${brand}\\b`).test(title) && !hostIn(page.hostname, domains)) {
        // Mere "Sign in with X" buttons without password fields are never enough.
        warnings.push({ id: `login-brand:${brand}`, reason: `This password page presents itself as ${brand}, but its address is ${page.hostname}.` });
      }
    }
  }
  return uniqueWarnings(warnings);
}

export function uniqueWarnings(warnings: SiteWarning[]): SiteWarning[] {
  return [...new Map(warnings.map((warning) => [warning.id, warning])).values()];
}

/** Self-contained isolated-world reader. Never reads field values or page text. */
export function collectLoginSignals(): LoginSignals {
  const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input[type="password"]'))
    .filter((input) => !input.disabled && input.getClientRects().length > 0).slice(0, 32);
  const forms = [...new Set(inputs.map((input) => input.form).filter((form): form is HTMLFormElement => !!form))];
  return {
    url: location.href, title: document.title.slice(0, 300), passwords: inputs.length,
    forms: forms.map((form) => ({ action: form.action, method: form.getAttribute('method')?.toLowerCase() ?? '' })),
  };
}
