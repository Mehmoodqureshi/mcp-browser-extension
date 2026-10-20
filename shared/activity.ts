import { WIRE_METHODS } from './protocol';
import { clientName } from './client-auth';

export const ACCESS_STOPPED_KEY = 'accessStopped';
export const ACTIVITY_KEY = 'recentActivity';
export const ACTIVITY_LIMIT = 100;
export type ActivityOutcome = 'running' | 'done' | 'blocked' | 'failed' | 'interrupted';
export interface ActivityEntry {
  id: string;
  at: number;
  method: string;
  host: string;
  /** Browser-session tab identity, used only to pair opening and closing. */
  tabId?: number;
  app: string;
  key: string;
  outcome: ActivityOutcome;
}

/** Deliberately excludes paths, queries, fragments, credentials and page data. */
export function activityHost(url: string): string {
  if (url === 'about:blank') return url;
  if (url === 'chrome://newtab/' || url === 'chrome://newtab' || url === 'chrome://new-tab-page/') return 'chrome://newtab';
  try {
    const parsed = new URL(url);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.hostname.slice(0, 253) : '';
  } catch { return ''; }
}

/** Reconstruct a fixed schema; never spread caller-supplied command data into storage. */
export function activityEntry(value: ActivityEntry): ActivityEntry {
  return {
    id: value.id.slice(0, 80),
    at: value.at,
    method: (WIRE_METHODS as readonly string[]).includes(value.method) ? value.method : 'unknown',
    host: activityHost(value.host) || activityHost(`https://${value.host}/`),
    ...(Number.isSafeInteger(value.tabId) && value.tabId! >= 0 ? { tabId: value.tabId } : {}),
    app: value.key ? clientName(value.app) : 'Unverified app',
    key: /^[a-f0-9]{64}$/.test(value.key) ? value.key : '',
    outcome: ['running', 'done', 'blocked', 'failed', 'interrupted'].includes(value.outcome) ? value.outcome : 'failed',
  };
}

export interface ActivityRow extends ActivityEntry { opened?: ActivityEntry }

/** Pair completed actions on the same tab and app; never merge by website alone. */
export function activityRows(entries: ActivityEntry[]): ActivityRow[] {
  const rows: ActivityRow[] = [];
  const opens = new Map<string, ActivityEntry>();
  for (const entry of entries) {
    const key = entry.tabId !== undefined && entry.key ? `${entry.key}:${entry.tabId}` : '';
    if (key && entry.method === 'tab_new' && entry.outcome === 'done') opens.set(key, entry);
    const opened = key && entry.method === 'tab_close' && entry.outcome === 'done' ? opens.get(key) : undefined;
    if (opened) {
      const index = rows.findIndex((row) => row.id === opened.id);
      if (index !== -1) rows.splice(index, 1);
      rows.push({ ...entry, host: entry.host || opened.host, opened });
      opens.delete(key);
    } else rows.push(entry);
  }
  return rows;
}

const LABELS: Record<string, string> = {
  tabs_list: 'List tabs', tab_select: 'Select tab', tab_new: 'Open tab', tab_close: 'Close tab',
  navigate: 'Navigate', back: 'Go back', forward: 'Go forward', reload: 'Reload page',
  click: 'Click', draw: 'Draw', type: 'Type text', press: 'Press key', hover: 'Hover',
  scroll: 'Scroll', screenshot: 'Take screenshot', get_text: 'Read text', get_html: 'Read HTML',
  eval: 'Run page script', snapshot: 'Read page structure', fill_form: 'Fill form',
  get_cookies: 'Read cookies', storage: 'Access site storage', download_file: 'Download file',
  upload_file: 'Upload file', print_pdf: 'Print PDF', select_option: 'Choose option',
  observers: 'Read page observations', proxy_status: 'Check proxy', frames: 'List frames',
};
export const activityLabel = (method: string): string => LABELS[method] ?? method.replaceAll('_', ' ');
