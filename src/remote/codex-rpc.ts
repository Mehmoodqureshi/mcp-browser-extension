import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { dirname } from 'node:path';

type Message = { id?: number | string; method?: string; params?: any; result?: any; error?: { message?: string } };
export interface CodexRpc {
  request(method: string, params: unknown): Promise<any>;
  notify(method: string, params: unknown): void;
  respond(id: number | string, result: unknown): void;
  close(): void;
}

export const CODEX_DISABLED_FEATURES = ['shell_tool', 'unified_exec', 'apps', 'plugins', 'remote_plugin', 'multi_agent', 'multi_agent_v2',
  'browser_use', 'browser_use_external', 'computer_use', 'image_generation', 'view_image', 'code_mode',
  'hooks', 'memories', 'skill_search', 'skill_mcp_dependency_install'];

/** Local stdio only. Codex owns its sign-in; credentials never enter the phone protocol. */
export function startCodexRpc(cwd: string, event: (message: Message) => void, failed: () => void): CodexRpc {
  const overrides = { web_search: 'disabled', notify: [], project_doc_max_bytes: 0, model_provider: 'openai',
    model_reasoning_effort: 'low', approval_policy: 'never', sandbox_mode: 'read-only', service_tier: 'default' };
  const args = ['app-server', '--listen', 'stdio://', ...CODEX_DISABLED_FEATURES.flatMap((name) => ['--disable', name]),
    ...Object.entries(overrides).flatMap(([key, value]) => ['-c', `${key}=${JSON.stringify(value)}`])];
  const env: NodeJS.ProcessEnv = { PATH: `${dirname(process.execPath)}:${process.env.PATH ?? '/usr/bin:/bin'}` };
  for (const key of ['HOME', 'USER', 'TMPDIR', 'LANG', 'CODEX_HOME']) if (process.env[key]) env[key] = process.env[key];
  const child: ChildProcessWithoutNullStreams = spawn(process.env.MBE_CODEX_BIN || 'codex', args, { cwd, env, stdio: 'pipe' });
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  let closed = false;
  let sequence = 0;
  let buffer = '';
  const close = (): void => {
    if (closed) return;
    closed = true;
    child.kill();
    const kill = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1500); kill.unref();
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error('Codex connection closed.')); }
    pending.clear(); buffer = '';
  };
  const fail = (): void => { if (!closed) { close(); failed(); } };
  const write = (message: unknown): void => { if (!closed) child.stdin.write(JSON.stringify(message) + '\n'); };
  child.stderr.resume(); // Do not log model text, browser content or account diagnostics.
  child.on('error', fail); child.on('exit', fail); child.stdin.on('error', fail);
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    if (buffer.length > 8 * 1024 * 1024) return fail();
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      let message: Message;
      try { message = JSON.parse(line); } catch { continue; }
      if (!message || typeof message !== 'object') continue;
      const request = typeof message.id === 'number' && !message.method ? pending.get(message.id) : undefined;
      if (request) {
        pending.delete(message.id as number); clearTimeout(request.timer);
        if (message.error) request.reject(new Error('Codex could not complete the request.'));
        else request.resolve(message.result);
      } else event(message);
    }
  });
  return {
    request: (method, params) => new Promise((resolve, reject) => {
      if (closed) return reject(new Error('Codex connection closed.'));
      const id = ++sequence;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Codex took too long to connect.')); }, 45_000);
      pending.set(id, { resolve, reject, timer }); write({ id, method, params });
    }),
    notify: (method, params) => write({ method, params }),
    respond: (id, result) => write({ id, result }), close,
  };
}
