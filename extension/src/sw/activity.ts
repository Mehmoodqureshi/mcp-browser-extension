import { ACTIVITY_LIMIT, activityEntry, type ActivityEntry } from '../../../shared/activity';

interface ActivityDeps {
  read(): Promise<unknown>;
  write(entries: ActivityEntry[]): Promise<void>;
}

/** Bounded session history. Failure to record never changes command permissions. */
export class ActivityLog {
  private queue: Promise<unknown> = Promise.resolve();
  private entries: ActivityEntry[] = [];
  private loaded = false;
  private generation = 0;
  private pending = 0;
  constructor(private readonly deps: ActivityDeps) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    const saved = await this.deps.read();
    this.entries = (Array.isArray(saved) ? saved : []).filter((v) =>
      v && typeof v.id === 'string' && Number.isFinite(v.at) && typeof v.method === 'string' &&
      typeof v.host === 'string' && typeof v.app === 'string' && typeof v.key === 'string'
    ).slice(-ACTIVITY_LIMIT).map((v) => activityEntry({
      ...v, outcome: v.outcome === 'running' ? 'interrupted' : v.outcome,
    }));
    this.loaded = true;
  }

  /** Clear history also prevents already-running requests from reappearing. */
  token(): number { return this.generation; }

  record(entry: ActivityEntry, generation = this.generation): Promise<void> {
    if (this.pending >= 256) return Promise.reject(new Error('Activity history is busy.'));
    this.pending++;
    const safe = activityEntry(entry);
    return this.serial(async () => {
      if (generation !== this.generation) return;
      await this.load();
      const next = this.entries.filter((e) => e.id !== safe.id);
      next.push(safe);
      next.sort((a, b) => a.at - b.at);
      this.entries = next.slice(-ACTIVITY_LIMIT);
      await this.deps.write(this.entries);
    }).finally(() => { this.pending--; });
  }

  clear(): Promise<void> {
    this.generation++;
    return this.serial(async () => {
      await this.deps.write([]);
      this.entries = [];
      this.loaded = true;
    });
  }

  interrupt(): Promise<void> {
    return this.serial(async () => {
      await this.load();
      this.entries = this.entries.map((e) => e.outcome === 'running' ? { ...e, outcome: 'interrupted' } : e);
      await this.deps.write(this.entries);
    });
  }
}
