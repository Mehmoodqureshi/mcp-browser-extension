import { isHealthProbe } from '../../../shared/client-auth';
import { activityHost, type ActivityEntry } from '../../../shared/activity';
/**
 * extension/src/sw/router.ts — the never-throw command firewall (the extension
 * mirror of the server's dispatchToolCall). Exactly one result/error frame per
 * command id; a thrown handler becomes an ErrorFrame, never an unhandled
 * rejection. Asserts at construction that every WireMethod has a handler.
 */

import {
  PROTOCOL_VERSION,
  WIRE_METHODS,
  type CommandFrame,
  type ErrorFrame,
  type ExecutorErrorCode,
  type ResultFrame,
  type WirePolicy,
} from '../../../shared/protocol';
import { evaluatePolicy, isUrlGated, isDomainAllowed, hostOf } from '../../../shared/policy';
import { ChromeExecutor, CmdError, HANDLED, observedTabUrl, resolveTab, urlForCommand } from './executor';
import { requireSitePermission } from './browser-permissions';

export interface RouterDeps {
  exec: ChromeExecutor;
  authorize?: (cmd: CommandFrame, verified?: (id: string, name: string) => void) => Promise<() => void>;
  access?: () => () => void;
  activity?: () => (entry: ActivityEntry) => void;
  send: (frame: ResultFrame | ErrorFrame) => void;
  /** The policy delivered in `welcome`, or null before one arrives. */
  getPolicy: () => WirePolicy | null;
  onBlocked?: (host: string, method: string) => void;
  log: (message: string) => void;
  /** The "mcp-browser-extension is working here" tab border; optional so tests can omit it. */
  border?: {
    used(tabId: number): Promise<void>;
    opened(tabId: number): Promise<void>;
    aroundCapture<T>(tabId: number | null, fn: () => Promise<T>): Promise<T>;
  };
}

/** True for a page served by this extension (Options and the like). */
function isOwnExtensionPage(url: string): boolean {
  try {
    return url.startsWith(chrome.runtime.getURL(''));
  } catch {
    return false;
  }
}

/** Commands whose output is an image of the page: the border is taken off first. */
const CAPTURES = new Set<string>(['screenshot', 'print_pdf']);

export class CommandRouter {
  constructor(private readonly deps: RouterDeps) {
    for (const m of WIRE_METHODS) {
      if (!HANDLED.has(m)) throw new Error(`router drift: no handler for wire method "${m}"`);
    }
  }

  async dispatch(cmd: CommandFrame, send = this.deps.send): Promise<void> {
    const record = this.deps.activity?.();
    // Health and approval probes carry no browser action and would swamp history.
    const entry: ActivityEntry | null = cmd.method === 'ping_probe' ? null : {
      id: crypto.randomUUID(), at: Date.now(), method: cmd.method, host: '', app: '', key: '', outcome: 'running',
    };
    let ran = false;
    let checkStopped: (() => void) | undefined;
    try {
      checkStopped = this.deps.access?.();
      if (isHealthProbe(cmd)) {
        send({ type: 'result', v: PROTOCOL_VERSION, id: cmd.id, ok: true, data: { ok: true } });
        return;
      }
      // THE authoritative policy gate. It runs the SAME shared `evaluatePolicy`
      // the server runs, but here it is decisive rather than defence-in-depth:
      // only this side can resolve the EXACT target tab (an explicit `tabId`, not
      // merely whichever tab is active) and read its URL in the instant before
      // the command executes. The server gates too, but from a URL that is by
      // construction one round-trip stale — so a client that reaches this socket
      // is constrained here, and here alone.
      //
      // Fails CLOSED: no policy (handshake incomplete) means nothing is known to
      // be permitted, so nothing runs. `ping_probe` is the one exemption — it
      // touches no page and no data, and the backend selector uses it to decide
      // whether this browser is alive at all.
      const policy = this.deps.getPolicy();
      if (!policy && cmd.method !== 'ping_probe') {
        throw new CmdError(
          'POLICY_DENIED',
          'no policy has arrived from the MCP Browser Extension server yet, so this extension is refusing every command',
        );
      }
      if (!this.deps.authorize) throw new CmdError('POLICY_DENIED', 'Client approval enforcement is unavailable.');
      const checkApproval = await this.deps.authorize(cmd, (id, name) => {
        if (entry) { entry.key = id; entry.app = name; }
      });
      const checkAccess = (): void => { checkStopped?.(); checkApproval(); };
      if (cmd.method === 'ping_probe') {
        checkAccess();
        send({ type: 'result', v: PROTOCOL_VERSION, id: cmd.id, ok: true, data: {} });
        return;
      }
      // One tab lookup serves the gate, the executor and the result frame.
      const tab = await resolveTab(cmd);
      if (entry && tab !== null) entry.tabId = tab;
      if (entry && cmd.method === 'tab_new') entry.host = activityHost(
        typeof cmd.params.url === 'string' ? cmd.params.url : 'chrome://newtab',
      );
      // Tab creation loads a page too; check its destination before running it.
      if (cmd.method === 'tab_new' && typeof cmd.params.url === 'string' && cmd.params.url !== 'about:blank') {
        const url = cmd.params.url;
        if (entry) entry.host = activityHost(url);
        if (isOwnExtensionPage(url)) throw new CmdError('POLICY_DENIED', 'MCP Browser Extension never acts on its own pages');
        const verdict = evaluatePolicy(url, 'navigate', policy!);
        if (!verdict.ok) {
          this.deps.onBlocked?.(hostOf(url), cmd.method);
          throw new CmdError('POLICY_DENIED', verdict.reason);
        }
        try { await requireSitePermission(url); }
        catch (err) { this.deps.onBlocked?.(hostOf(url), cmd.method); throw err; }
      }
      const targetUrl = tab !== null ? await observedTabUrl(cmd, tab) : '';
      if (tab !== null && isOwnExtensionPage(targetUrl)) {
        throw new CmdError('POLICY_DENIED', 'MCP Browser Extension never acts on its own pages');
      }
      // Capture the resolved target before actions such as closing a tab remove it.
      if (entry && tab !== null && !isUrlGated(cmd.method)) entry.host = activityHost(targetUrl);
      if (policy) {
        const url = isUrlGated(cmd.method) ? await urlForCommand(cmd, tab) : '';
        if (entry && url) entry.host = activityHost(url);
        // This extension's own pages are where a person allows sites. The agent
        // must never read or drive them, whatever the allowlist says, or it
        // could approve a site for itself.
        if (url && isOwnExtensionPage(url)) {
          throw new CmdError('POLICY_DENIED', "MCP Browser Extension never acts on its own pages");
        }
        const verdict = evaluatePolicy(url, cmd.method, policy);
        if (!verdict.ok) {
          const host = hostOf(url);
          if (host && isUrlGated(cmd.method) && !isDomainAllowed(url, policy)) this.deps.onBlocked?.(host, cmd.method);
          throw new CmdError('POLICY_DENIED', verdict.reason);
        }
        if (isUrlGated(cmd.method) && url !== 'about:blank') {
          try { await requireSitePermission(url); }
          catch (err) {
            const host = hostOf(url);
            if (host) this.deps.onBlocked?.(host, cmd.method);
            throw err;
          }
        }
      }
      checkAccess();
      const run = (): Promise<unknown> => {
        checkAccess();
        ran = true;
        if (entry) record?.({ ...entry });
        return this.deps.exec.run(cmd, tab);
      };
      const border = this.deps.border;
      const data =
        border && CAPTURES.has(cmd.method)
          ? await border.aroundCapture(tab, run)
          : await run();
      checkAccess();
      if (entry && cmd.method === 'tab_new') {
        const opened = data as { tabId?: string; url?: string } | null;
        const id = Number(opened?.tabId?.split(':')[2]);
        if (Number.isSafeInteger(id) && id >= 0) entry.tabId = id;
        if (opened?.url) entry.host = activityHost(opened.url) || entry.host;
      }
      if (border) void this.markBorder(border, cmd, tab, data);
      const frame: ResultFrame = { type: 'result', v: PROTOCOL_VERSION, id: cmd.id, ok: true, data };
      // Ride the tab's landing URL home so the server's next gate needs no
      // round-trip. Best-effort: a closed/unreadable tab just omits it.
      const tabUrl = await observedTabUrl(cmd, tab);
      checkAccess();
      if (tabUrl) frame.tabUrl = tabUrl;
      if (entry) {
        // Tabless requests must not inherit the unrelated active tab's website.
        if (!entry.host && tab !== null && tabUrl) entry.host = activityHost(tabUrl);
        const result = data as { ok?: boolean; error?: unknown } | null;
        entry.outcome = (cmd.method === 'fill_form' && result?.error) ||
          (cmd.method === 'eval' && result?.ok === false) ? 'failed' : 'done';
      }
      send(frame);
    } catch (err) {
      const code: ExecutorErrorCode = err instanceof CmdError ? err.code : 'CDP_ERROR';
      const message = err instanceof Error ? err.message : String(err);
      if (entry) entry.outcome = ran && code === 'POLICY_DENIED' ? 'interrupted' : code === 'POLICY_DENIED' ? 'blocked' : 'failed';
      this.deps.log(`command "${cmd.method}" failed: ${message}`);
      const frame: ErrorFrame = {
        type: 'error',
        v: PROTOCOL_VERSION,
        id: cmd.id,
        ok: false,
        error: { code, message },
      };
      send(frame);
    } finally {
      if (entry) record?.(entry);
    }
  }

  /** Border the tab a successful command worked in. Never delays or fails the reply. */
  private async markBorder(
    border: NonNullable<RouterDeps['border']>,
    cmd: CommandFrame,
    tab: number | null,
    data: unknown,
  ): Promise<void> {
    try {
      if (cmd.method === 'tab_new') {
        const handle = (data as { tabId?: unknown } | null)?.tabId;
        const id = typeof handle === 'string' ? Number(handle.split(':')[2]) : NaN;
        if (Number.isInteger(id)) await border.opened(id);
      } else if (tab !== null && cmd.method !== 'tab_close') {
        await border.used(tab);
      }
    } catch {
      /* cosmetic only */
    }
  }
}
