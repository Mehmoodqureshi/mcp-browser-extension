import { siteOrigins } from '../../shared/browser-permissions';
import { normalizeDomainPattern } from '../../shared/policy';

export async function permittedSites(sites: string[]): Promise<string[]> {
  const checks = await Promise.all(sites.map(async (site) => {
    const origins = siteOrigins(site);
    return origins.length && await chrome.permissions.contains({ origins }).catch(() => false) ? site : null;
  }));
  return checks.filter((site): site is string => site !== null);
}

/** Send the click immediately; the worker owns the request if Chrome closes the popup. */
export async function changeSiteAccess(input: string, allow: boolean): Promise<{ ok: boolean; error?: string }> {
  const origins = siteOrigins(input);
  if (!origins.length) return { ok: false, error: 'Please enter one website, such as example.com. All-site access is not available.' };
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'site_access', host: normalizeDomainPattern(input), allow,
    }) as { ok: boolean; error?: string } | undefined;
    return result ?? { ok: false, error: 'Please start your connected app and try again.' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Could not change this website permission. Please try again.' };
  }
}
