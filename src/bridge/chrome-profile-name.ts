/**
 * src/bridge/chrome-profile-name.ts — the Chrome profile an extension install runs in.
 *
 * Chrome never tells an extension which profile it runs in, but this server runs
 * on the same computer. Each profile keeps the extension's chrome.storage.local
 * under `<profile>/Local Extension Settings/<extension id>/`, and that storage
 * holds the install's random installId. Finding the id names the profile folder;
 * `Local State` maps the folder to the name on Chrome's profile icon. Read-only
 * and best effort: anything unclear returns undefined and naming falls back.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { browserDataDirs } from '../extension-repair';

/** Storage files bigger than this are skipped; ours are a few hundred KB at most. */
const MAX_FILE_BYTES = 8 * 1024 * 1024;

const found = new Map<string, string | undefined>();

function profileNames(root: string): Record<string, string> {
  try {
    const state = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8')) as {
      profile?: { info_cache?: Record<string, { name?: unknown }> };
    };
    const out: Record<string, string> = {};
    for (const [dir, info] of Object.entries(state.profile?.info_cache ?? {})) {
      if (typeof info?.name === 'string' && info.name.trim()) out[dir] = info.name.trim();
    }
    return out;
  } catch {
    return {};
  }
}

function storageHolds(folder: string, needle: Buffer): boolean {
  let files: string[];
  try {
    files = readdirSync(folder).filter((f) => f.endsWith('.log') || f.endsWith('.ldb'));
  } catch {
    return false;
  }
  for (const f of files) {
    try {
      const path = join(folder, f);
      if (statSync(path).size > MAX_FILE_BYTES) continue;
      if (readFileSync(path).includes(needle)) return true;
    } catch {
      /* locked or vanished: try the next file */
    }
  }
  return false;
}

/**
 * The display name of the Chrome profile holding this install, e.g. "Mehmood701".
 * Only answers when exactly one profile matches.
 */
export function chromeProfileName(extId: unknown, installId: string, roots = browserDataDirs()): string | undefined {
  if (typeof extId !== 'string' || !/^[a-p]{32}$/.test(extId)) return undefined;
  const key = `${extId}/${installId}`;
  if (found.has(key)) return found.get(key);
  const needle = Buffer.from(installId, 'utf8');
  const matches: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const [dir, name] of Object.entries(profileNames(root))) {
      if (storageHolds(join(root, dir, 'Local Extension Settings', extId), needle)) matches.push(name);
    }
  }
  const name = matches.length === 1 ? matches[0] : undefined;
  // Remember only a hit: a brand-new install may not have flushed its storage yet.
  if (name) found.set(key, name);
  return name;
}

/** Routing keys for every Chrome profile on this computer, e.g. ["mehmood", "muhammad"]. */
export function chromeProfileKeys(roots = browserDataDirs()): string[] {
  const keys = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const name of Object.values(profileNames(root))) {
      const key = profileKeyFromChromeName(name);
      if (key) keys.add(key);
    }
  }
  return [...keys];
}

/** A Chrome profile name as a routing key: "Mehmood 701" → "mehmood-701". */
export function profileKeyFromChromeName(name: string): string | undefined {
  const key = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '');
  return key || undefined;
}
