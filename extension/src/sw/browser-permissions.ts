import { blockedDomainMessage, hostOf } from '../../../shared/policy';
import {
  FEATURE_REQUESTS_KEY, OPTIONAL_FEATURES, PERMISSIONS_MIGRATION_KEY,
  PROXY_AUTH_PERMISSIONS, isGlobalOrigin, originForUrl, type OptionalFeature,
} from '../../../shared/browser-permissions';
import { PROXY_STORAGE_KEY, parseProxyConfig } from '../../../shared/proxy';
import { CmdError } from './cmd-error';
import { checkLocalSite, keepAutomaticPermissions, refreshSiteChecks, requireSiteChecksReady } from './site-protection';

let initialization: Promise<void> | undefined;

/** Upgrades must not inherit the previous install's blanket host grant. */
export function initializeBrowserPermissions(): Promise<void> {
  return initialization ??= (async () => {
    await removeGlobalOrigins();
    await refreshSiteChecks();
    const saved = await chrome.storage.local.get([PERMISSIONS_MIGRATION_KEY, PROXY_STORAGE_KEY]);
    if (!saved[PERMISSIONS_MIGRATION_KEY]) {
      const permissions = ['cookies', 'downloads'];
      // Do not silently switch off an active proxy and expose the person's IP.
      if (!parseProxyConfig(saved[PROXY_STORAGE_KEY])?.enabled) permissions.push(...PROXY_AUTH_PERMISSIONS);
      await chrome.permissions.remove({ permissions });
      await chrome.storage.local.set({ [PERMISSIONS_MIGRATION_KEY]: true });
    }
  })();
}

export async function removeGlobalOrigins(): Promise<void> {
  if (await keepAutomaticPermissions()) return;
  const all = await chrome.permissions.getAll();
  const origins = (all.origins ?? []).filter(isGlobalOrigin);
  if (origins.length) await chrome.permissions.remove({ origins });
  const remaining = await chrome.permissions.getAll();
  if (remaining.origins?.some(isGlobalOrigin)) throw new Error('Please remove all-site access in Chrome before continuing.');
}

/** Also used immediately before debugger access, which bypasses host permissions. */
export async function requireSitePermission(url: string, tabId?: number, frameId = 0): Promise<void> {
  await initializeBrowserPermissions();
  if (url === 'about:blank') return;
  requireSiteChecksReady();
  const origin = originForUrl(url);
  if (origin && await chrome.permissions.contains({ origins: [origin] })) {
    await checkLocalSite(url, tabId, frameId);
    return;
  }
  throw new CmdError('POLICY_DENIED', blockedDomainMessage(hostOf(url) || url));
}

let requestWrite = Promise.resolve();
export async function requireFeaturePermission(feature: OptionalFeature): Promise<void> {
  await initializeBrowserPermissions();
  if (await chrome.permissions.contains({ permissions: [feature] })) return;
  const write = requestWrite.then(async () => {
    const saved = (await chrome.storage.local.get(FEATURE_REQUESTS_KEY))[FEATURE_REQUESTS_KEY];
    const requests = Array.isArray(saved) ? saved.filter((x): x is OptionalFeature => typeof x === 'string' && x in OPTIONAL_FEATURES) : [];
    await chrome.storage.local.set({ [FEATURE_REQUESTS_KEY]: [...new Set([...requests, feature])] });
  });
  requestWrite = write.catch(() => undefined);
  await write;
  const label = OPTIONAL_FEATURES[feature].label;
  throw new CmdError('POLICY_DENIED', `Please allow ${label.toLowerCase()}: Chrome → MCP Browser Extension icon → Extra permissions → Allow ${label.toLowerCase()}, then try again.`);
}
