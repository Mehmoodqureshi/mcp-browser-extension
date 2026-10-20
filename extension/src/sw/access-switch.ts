import { CmdError } from './cmd-error';

interface AccessDeps {
  read(): Promise<unknown>;
  write(stopped: boolean): Promise<void>;
  revoke(): Promise<void>;
  disconnect(): void;
}

/** A durable stop, independent of pairing, alarms, policy updates and app keys. */
export class AccessSwitch {
  stopped = true;
  private loaded = false;
  private epoch = 0;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly deps: AccessDeps) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }

  initialize(): Promise<void> {
    return this.serial(async () => {
      if (this.loaded) return;
      const epoch = this.epoch;
      const saved = await this.deps.read();
      if (epoch !== this.epoch || this.epoch !== 0) return;
      // Unknown values fail closed, just like a failed read.
      this.stopped = saved !== undefined && saved !== false;
      this.loaded = true;
    });
  }

  check(): () => void {
    const epoch = this.epoch;
    const check = (): void => {
      if (!this.loaded || this.stopped || epoch !== this.epoch) {
        throw new CmdError('POLICY_DENIED', 'Browser access is stopped. Use Resume connection in the extension popup or Settings, then approve your app again.');
      }
    };
    check();
    return check;
  }

  stop(): Promise<void> {
    // Synchronous: invalidate already-authorized work before any storage awaits.
    this.stopped = true;
    this.epoch++;
    this.deps.disconnect();
    return this.serial(async () => {
      await this.deps.write(true);
      this.loaded = true;
      await this.deps.revoke();
    });
  }

  resume(): Promise<void> {
    const epoch = this.epoch;
    return this.serial(async () => {
      if (epoch !== this.epoch) return;
      // A previous stop may have failed while revoking: retry before reconnecting.
      this.stopped = true;
      await this.deps.write(true);
      await this.deps.revoke();
      if (epoch !== this.epoch) return;
      await this.deps.write(false);
      if (epoch !== this.epoch) {
        await this.deps.write(true);
        return;
      }
      this.loaded = true;
      this.stopped = false;
    });
  }
}
