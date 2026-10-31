/**
 * shared/policy.ts — the PURE policy decision, imported VERBATIM by both the
 * server (src/security/policy.ts wraps it to throw ExecutorError) and the
 * extension (router mirrors it to throw CmdError). Keeping the decision in one
 * shared module is what makes the two ends provably agree — the gate is then
 * genuinely enforced "at both ends" (server dispatch AND extension router).
 *
 * No throwing, no Node/Chrome deps: returns a verdict the caller renders into
 * whatever error type it uses.
 */

import type { WireMethod, WirePolicy } from './protocol';

// ---------------------------------------------------------------------------
// Method classification
// ---------------------------------------------------------------------------

/** Methods that read page CONTENT (the exfil payload) — URL-gated. */
const READ_CONTENT: ReadonlySet<WireMethod> = new Set<WireMethod>([
  'get_text',
  'get_html',
  'screenshot',
  'wait_for',
  // A frame list leaks the URLs a page embeds; console/network buffers are the
  // page's own traffic and error text; a PDF is a screenshot by another name.
  // All three are page CONTENT and gate exactly like the reads above.
  'frames_list',
  'observers',
  'print_pdf',
  // The page's accessibility tree, its cookies (session secrets), and its
  // web storage are content too. A storage write is refused in safe mode by
  // the extension's storage handler; the domain gate here covers every op.
  'snapshot',
  'get_cookies',
  'storage',
]);

/** Content-mutating actions — URL-gated AND mutation-gated. */
const MUTATE_CONTENT: ReadonlySet<WireMethod> = new Set<WireMethod>([
  'click',
  'draw',
  'type',
  'press',
  'hover',
  'scroll',
  'fill_form',
  'select_option',
]);

/** Navigation — URL-gated by the DESTINATION url, and mutation-gated. */
const NAVIGATION: ReadonlySet<WireMethod> = new Set<WireMethod>([
  'navigate',
  'back',
  'forward',
  'reload',
]);

/** Tab management — mutation-gated, but not content-URL-gated. */
const TAB_MUTATE: ReadonlySet<WireMethod> = new Set<WireMethod>([
  'tab_select',
  'tab_new',
  'tab_close',
]);

export function isReadMethod(method: WireMethod): boolean {
  return READ_CONTENT.has(method) || method === 'tabs_list';
}

/** Everything in the mutating tool set that safe-mode disables. `eval` is gated
 *  separately via `allowEval`; `download_file` separately via `allowDownloads`. */
export function isMutatingMethod(method: WireMethod): boolean {
  return MUTATE_CONTENT.has(method) || NAVIGATION.has(method) || TAB_MUTATE.has(method);
}

/** Whether the method touches a specific URL that must be allowlisted. */
export function isUrlGated(method: WireMethod): boolean {
  return (
    READ_CONTENT.has(method) ||
    MUTATE_CONTENT.has(method) ||
    NAVIGATION.has(method) ||
    method === 'eval' ||
    method === 'upload_file' ||
    // Gated on where the bytes come from: the URL when one is given, else the tab.
    method === 'download_file'
  );
}

// ---------------------------------------------------------------------------
// Domain matching
// ---------------------------------------------------------------------------

/** Parse a host out of a URL string; '' if it has none (about:blank, data:, …). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isAboutBlank(url: string): boolean {
  return url === 'about:blank' || url === '' || url.startsWith('about:');
}

/**
 * Reduce an allowlist entry to the bare host it constrains. Users routinely paste
 * a full URL ("https://example.com/app") or a "host:port/path" instead of a bare
 * host; those forms would never equal a hostname and so silently match nothing.
 * We strip the scheme, userinfo, port, and path/query/fragment, preserving a
 * leading "*." for a named site's subdomains. Catch-all patterns and patterns
 * without a host return '' and never grant access.
 */
export function normalizeDomainPattern(pattern: string): string {
  let p = pattern.trim().toLowerCase();
  if (p === '*' || p === '*://*/*' || p === '<all_urls>') return '';
  // Strip a leading scheme ("https://", "http://", any "scheme://").
  p = p.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  // Drop everything from the first path/query/fragment separator onward.
  p = p.replace(/[/?#].*$/, '');
  // Strip userinfo ("user:pass@") then a trailing port (":8080").
  p = p.replace(/^[^@]*@/, '').replace(/:\d+$/, '');
  return p === '*' || p === '*.' ? '' : p;
}

/** Convert a named domain pattern to a predicate.
 *  '*.example.com' matches example.com and any subdomain; otherwise exact host.
 *  URL/port/path forms are normalized to their bare host first. */
function globMatches(host: string, pattern: string): boolean {
  const p = normalizeDomainPattern(pattern);
  if (p.startsWith('*.')) {
    const base = p.slice(2);
    return host === base || host.endsWith('.' + base);
  }
  return p !== '' && host === p;
}

export function isDomainAllowed(url: string, policy: WirePolicy): boolean {
  const host = hostOf(url);
  if (!host) return false;
  if (policy.automaticSites && /^https?:\/\//i.test(url)) {
    return !(policy.blockedDomains ?? []).some((pat) => globMatches(host, pat));
  }
  return policy.allowDomains.some((pat) => globMatches(host, pat));
}

// ---------------------------------------------------------------------------
// The gate (pure)
// ---------------------------------------------------------------------------

export type PolicyVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether `method` against `url` is permitted by `policy`. `url` is the
 * DESTINATION for navigation, otherwise the current tab URL. Pure: returns a
 * verdict; the caller throws its own error type on `{ ok: false }`.
 */
export function evaluatePolicy(url: string, method: WireMethod, policy: WirePolicy): PolicyVerdict {
  // -- capability gates (independent of URL) --
  if (method === 'eval' && !policy.allowEval) {
    return { ok: false, reason: 'eval is disabled (safe-mode). Pass --unsafe-enable-eval to allow it.' };
  }
  if (method === 'download_file' && !policy.allowDownloads) {
    return { ok: false, reason: 'downloads are disabled. Pass --enable-downloads or set allowDownloads.' };
  }
  if (method === 'observers' && !policy.allowObservers) {
    return {
      ok: false,
      reason:
        'the in-page observers (console_logs / network_log / dialogs) are disabled. They patch console, ' +
        'fetch, XMLHttpRequest and the dialog functions on every allowlisted page in your real browser, ' +
        'so they are opt-in: pass --enable-observers or set allowObservers.',
    };
  }
  if (method === 'upload_file' && !policy.allowUploads) {
    return {
      ok: false,
      reason:
        'uploads are disabled (sending local files to a page is an exfiltration risk). ' +
        'Pass --enable-uploads or set allowUploads.',
    };
  }
  if (isMutatingMethod(method) && !policy.enableMutations) {
    return {
      ok: false,
      reason: `mutating tool "${method}" is disabled (safe-mode). Pass --enable-mutations to allow it.`,
    };
  }

  // Methods that don't carry a content URL pass once the gates above are clear.
  if (!isUrlGated(method)) return { ok: true };

  // Navigating to a blank page is always fine.
  if (isAboutBlank(url) && NAVIGATION.has(method)) return { ok: true };

  if (!isDomainAllowed(url, policy)) {
    const host = hostOf(url) || url;
    if (policy.automaticSites && /^https?:\/\//i.test(url)) return {
      ok: false, reason: `Access to ${host} was removed. Restore it under Blocked websites in extension Settings.`,
    };
    return { ok: false, reason: blockedDomainMessage(host) };
  }
  return { ok: true };
}

/**
 * One friendly line with the person's next step. The agent must relay it and
 * wait; only the person can approve the site in Chrome.
 */
export function blockedDomainMessage(host: string): string {
  // New installs sit inside Chrome's puzzle-piece menu, where the "?" badge is
  // hidden, so the steps say where to find the icon.
  return `Please allow access to ${host}: in Chrome, click the MCP Browser Extension icon (inside the puzzle-piece Extensions menu if it is not pinned), then click Allow next to ${host}.`;
}

/** A wire policy that allows nothing — the safe default when none was delivered. */
export const DENY_ALL_WIRE_POLICY: WirePolicy = {
  allowDomains: [],
  allowEval: false,
  allowDownloads: false,
  allowUploads: false,
  allowAllTabs: false,
  enableMutations: false,
  allowObservers: false,
};
