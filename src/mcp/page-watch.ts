/** Persistent, profile-scoped accessibility checkpoints for pages the user allows. */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SnapshotNode, SnapshotResult } from '../executor/types';
import type { SnapshotDiff, StoredSnapshot } from './snapdiff';
import { diffSnapshots } from './snapdiff';

export interface PageWatch extends StoredSnapshot { name: string; }

function root(profileDir: string): string {
  const dir = join(profileDir, 'page-watches');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function watchPath(profileDir: string, id: string): string {
  if (!/^watch_[0-9a-f-]{36}$/i.test(id)) throw new Error('invalid watchId');
  return join(root(profileDir), `${id}.json`);
}

/** Keep enough structure for useful diffs while never persisting live form values. */
export function safeSnapshot(snap: SnapshotResult, redact: (s: string) => string): SnapshotResult {
  const nodes: SnapshotNode[] = snap.nodes.slice(0, 500).map((node) => {
    const { value: _privateValue, ...safe } = node;
    return { ...safe, name: redact(safe.name) };
  });
  let url = snap.url;
  try { const parsed = new URL(url); parsed.search = ''; parsed.hash = ''; url = parsed.toString(); } catch { /* keep non-URL test fixtures as given */ }
  return { url, title: redact(snap.title), nodes, truncated: snap.truncated };
}

export function createWatch(profileDir: string, name: string, snap: SnapshotResult): PageWatch {
  const id = `watch_${randomUUID()}`;
  const watch: PageWatch = { id, name, ts: Date.now(), url: snap.url, nodes: snap.nodes };
  const dir = root(profileDir);
  const temp = join(dir, `.${id}.${process.pid}.tmp`);
  writeFileSync(temp, JSON.stringify(watch), { mode: 0o600, flag: 'wx' });
  renameSync(temp, watchPath(profileDir, id));
  return watch;
}

export function readWatch(profileDir: string, id: string): PageWatch {
  const path = watchPath(profileDir, id);
  if (!existsSync(path)) throw new Error(`page watch not found: ${id}`);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as PageWatch;
  if (parsed.id !== id || !Array.isArray(parsed.nodes)) throw new Error('page watch file is invalid');
  return parsed;
}

export function listWatches(profileDir: string): Array<Pick<PageWatch, 'id' | 'name' | 'ts' | 'url'>> {
  return readdirSync(root(profileDir)).filter((f) => /^watch_[0-9a-f-]{36}\.json$/i.test(f)).flatMap((file) => {
    try {
      const { id, name, ts, url } = JSON.parse(readFileSync(join(root(profileDir), file), 'utf8')) as PageWatch;
      return [{ id, name, ts, url }];
    } catch { return []; }
  }).sort((a, b) => b.ts - a.ts);
}

export function removeWatch(profileDir: string, id: string): void {
  const path = watchPath(profileDir, id);
  if (!existsSync(path)) throw new Error(`page watch not found: ${id}`);
  rmSync(path);
}

export function compareWatch(previous: PageWatch, current: SnapshotResult, redact: (s: string) => string): SnapshotDiff {
  const clean = safeSnapshot(current, redact);
  return diffSnapshots(previous, { ...clean, nodes: clean.nodes });
}
