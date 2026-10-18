/**
 * src/bridge/host-claim.ts — retire a server its MCP host has replaced.
 *
 * Some hosts (Claude Code's /mcp "Reconnect" among them) spawn a fresh child
 * without closing the old one's stdin or signalling it. The old server then
 * lingers with its OLD flags and, if it holds the port, keeps serving the
 * browser: a reconnect that was meant to apply a new flag silently doesn't.
 *
 * Each stdio server claims `hosts/<parentPid>-<profile>` on start. The newest
 * claim wins; an older server that finds someone else's pid in its claim file
 * knows the same host replaced it and shuts itself down. Nothing is ever killed
 * here, so a recycled pid cannot cause a wrong kill.
 */

import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { writeFileAtomic } from '../atomic-file';

function claimPath(dataDir: string, parentPid: number, profile: string): string {
  const safe = profile.replace(/[^A-Za-z0-9._-]/g, '_') || 'default';
  return join(dataDir, 'hosts', `${parentPid}-${safe}`);
}

/** Record this process as the current server for (parent, profile). */
export function claimHost(dataDir: string, parentPid: number, profile: string, pid = process.pid): void {
  mkdirSync(join(dataDir, 'hosts'), { recursive: true, mode: 0o700 });
  writeFileAtomic(claimPath(dataDir, parentPid, profile), `${pid}\n`, 0o600);
}

/** True when a newer server from the same parent has claimed (parent, profile). */
export function supersededBy(dataDir: string, parentPid: number, profile: string, pid = process.pid): number | null {
  let text: string;
  try {
    text = readFileSync(claimPath(dataDir, parentPid, profile), 'utf8');
  } catch {
    return null; // missing or unreadable: never retire on doubt
  }
  const owner = Number.parseInt(text.trim(), 10);
  return Number.isInteger(owner) && owner > 0 && owner !== pid ? owner : null;
}
