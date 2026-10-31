import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSync } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { SITE_CHECKS_KEY, SITE_CHECKS_PENDING_KEY, SITE_CHECKS_APPROVALS_KEY, type LoginSignals, type SiteWarningRequest } from '../shared/site-risk';

const source = buildSync({ entryPoints: ['extension/src/sw/site-protection.ts'], bundle: true, write: false, platform: 'browser', format: 'cjs' }).outputFiles[0].text;
interface Protection {
  changeSiteChecks(allow: boolean): Promise<void>;
  refreshSiteChecks(): Promise<void>;
  checkLocalSite(url: string, tab?: number): Promise<void>;
  allowSiteWarning(origin: string, reasons: string[]): Promise<void>;
  revokeSiteWarning(origin: string): Promise<void>;
  blockLocalSite(host: string, block: boolean): Promise<void>;
  localSitePolicy(policy: unknown): { automaticSites: boolean };
  siteChecksEnabled(): boolean;
  siteChecksConfigured(): boolean;
  setSiteChecksSupported(value: boolean): void;
}
function fixture() {
  const saved: Record<string, any> = {};
  let permission = false, consent = true;
  let requestError: Error | undefined;
  let page: LoginSignals = { url: 'https://ordinary.test/', title: 'Ordinary page', passwords: 0, forms: [] };
  const module = { exports: {} as Protection };
  runInNewContext(source, { module, exports: module.exports, URL,
    chrome: {
      storage: { local: {
        get: async () => structuredClone(saved),
        set: async (values: object) => { Object.assign(saved, structuredClone(values)); },
      } },
      permissions: {
        contains: async () => permission,
        request: () => {
          if (requestError) { const error = requestError; requestError = undefined; throw error; }
          permission = consent; return Promise.resolve(consent);
        },
        remove: async () => { permission = false; return true; },
      },
      scripting: { executeScript: async () => [{ result: page }] },
    },
  });
  return { p: module.exports, saved, setPage: (value: LoginSignals) => { page = value; },
    failRequest: () => { requestError = new Error('Chrome rejected the request'); },
    refuse: () => { consent = false; }, removePermission: () => { permission = false; } };
}

test('a synchronous Chrome permission error permits a later trusted retry', async () => {
  const f = fixture();
  f.failRequest();
  await assert.rejects(f.p.changeSiteChecks(true), /Chrome rejected/);
  assert.equal(f.p.siteChecksEnabled(), false);
  await f.p.changeSiteChecks(true);
  assert.equal(f.p.siteChecksEnabled(), true);
});

test('checks default on but require Chrome consent without queueing ordinary websites', async () => {
  const f = fixture();
  await f.p.refreshSiteChecks();
  assert.equal(f.p.siteChecksConfigured(), true);
  assert.equal(f.p.siteChecksEnabled(), false);
  await assert.rejects(f.p.checkLocalSite('https://ordinary.test/'), /Allow website access/);
  assert.equal(f.saved[SITE_CHECKS_PENDING_KEY], undefined);
  await f.p.changeSiteChecks(false);
  await f.p.refreshSiteChecks();
  assert.equal(f.p.siteChecksConfigured(), false, 'an explicit choice to use named-site access survives refresh');
});

test('an older or locked server retains its named-site gate without requiring unsupported automatic setup', async () => {
  const f = fixture();
  f.p.setSiteChecksSupported(false);
  await f.p.refreshSiteChecks();
  assert.equal(f.p.siteChecksConfigured(), false);
  await f.p.checkLocalSite('https://ordinary.test/');
  assert.equal(f.p.localSitePolicy({ allowDomains: ['ordinary.test'] }).automaticSites, false);
});

test('automatic access requires actual Chrome consent, and a server cannot opt a browser in', async () => {
  const f = fixture();
  await f.p.refreshSiteChecks();
  assert.equal(f.p.localSitePolicy({ automaticSites: true }).automaticSites, false);
  f.refuse();
  await assert.rejects(f.p.changeSiteChecks(true), /not enabled/);
  assert.notEqual(f.saved[SITE_CHECKS_KEY], true);
  assert.equal(f.p.siteChecksEnabled(), false);
});

test('ordinary sites produce no pending request and no stored approval', async () => {
  const f = fixture();
  await f.p.changeSiteChecks(true);
  await f.p.checkLocalSite('https://ordinary.test/', 10);
  await f.p.checkLocalSite('https://another.test/');
  assert.equal(f.saved[SITE_CHECKS_PENDING_KEY], undefined);
  assert.equal(f.saved[SITE_CHECKS_APPROVALS_KEY], undefined);
  assert.equal(f.p.localSitePolicy({ allowDomains: [] }).automaticSites, true);
});

test('warnings require review and approval applies only to the displayed reasons and origin', async () => {
  const f = fixture();
  await f.p.changeSiteChecks(true);
  const url = 'https://google-login.example/';
  await assert.rejects(f.p.checkLocalSite(url), /Suspicious website/);
  const request = f.saved[SITE_CHECKS_PENDING_KEY][0] as SiteWarningRequest;
  await assert.rejects(f.p.allowSiteWarning(request.origin, ['different-warning']), /warning changed/);
  await f.p.allowSiteWarning(request.origin, request.warnings.map((w) => w.id));
  await f.p.checkLocalSite(url);
  assert.equal(f.saved[SITE_CHECKS_PENDING_KEY].length, 0);
  await assert.rejects(f.p.checkLocalSite('http://google-login.example/'), /Suspicious website/);
  await assert.rejects(f.p.checkLocalSite('https://google-login.example:444/'), /Suspicious website/);
  f.setPage({ url, title: 'Sign in', passwords: 1, forms: [{ action: 'http://receiver.test/', method: 'post' }] });
  await assert.rejects(f.p.checkLocalSite(url, 10), /unencrypted/);
  assert.equal(f.saved[SITE_CHECKS_PENDING_KEY][0].warnings.length, 1, 'only the new reason needs review');
});

test('approving one concurrent warning does not discard another, and new reasons invalidate a stale click', async () => {
  const f = fixture();
  await f.p.changeSiteChecks(true);
  f.setPage({ url: 'https://ordinary.test/', title: 'Sign in to Google', passwords: 1, forms: [] });
  await Promise.allSettled([f.p.checkLocalSite('https://ordinary.test/', 10), f.p.checkLocalSite('https://paypal-login.example/')]);
  assert.equal(f.saved[SITE_CHECKS_PENDING_KEY].length, 2);
  const request: SiteWarningRequest = f.saved[SITE_CHECKS_PENDING_KEY].find((r: SiteWarningRequest) => r.host === 'ordinary.test');
  f.setPage({ url: `${request.origin}/`, title: 'Sign in to Google', passwords: 1, forms: [{ action: '/login', method: 'get' }] });
  await assert.rejects(f.p.checkLocalSite(`${request.origin}/`, 10));
  await assert.rejects(f.p.allowSiteWarning(request.origin, request.warnings.map((w) => w.id)), /warning changed/);
  assert.equal(f.saved[SITE_CHECKS_PENDING_KEY].length, 2);
});

test('manual blocks and revoked exceptions take effect while ordinary sites stay automatic', async () => {
  const f = fixture();
  await f.p.changeSiteChecks(true);
  await f.p.blockLocalSite('ordinary.test', true);
  await assert.rejects(f.p.checkLocalSite('https://ordinary.test/'), /Access.*removed/);
  assert.equal(f.saved[SITE_CHECKS_PENDING_KEY]?.length ?? 0, 0, 'manual blocks are not pending warnings');
  await f.p.blockLocalSite('ordinary.test', false);
  await f.p.checkLocalSite('https://ordinary.test/');
  await assert.rejects(f.p.checkLocalSite('https://paypa1.com/'));
  const request: SiteWarningRequest = f.saved[SITE_CHECKS_PENDING_KEY][0];
  await f.p.allowSiteWarning(request.origin, request.warnings.map((w) => w.id));
  await f.p.revokeSiteWarning(request.origin);
  await assert.rejects(f.p.checkLocalSite('https://paypa1.com/'), /Suspicious website/);
});

test('revoked Chrome permission requires setup again, never a false clean verdict', async () => {
  const f = fixture();
  await f.p.changeSiteChecks(true);
  f.removePermission();
  await f.p.refreshSiteChecks();
  await assert.rejects(f.p.checkLocalSite('https://ordinary.test/'), /needs Chrome permission/);
  assert.equal(f.p.localSitePolicy({ allowDomains: [] }).automaticSites, false);
});

test('a page changing during the check fails without labelling it a scam', async () => {
  const f = fixture();
  await f.p.changeSiteChecks(true);
  await assert.rejects(f.p.checkLocalSite('https://different.test/', 10), /Could not finish/);
  assert.equal(f.saved[SITE_CHECKS_PENDING_KEY], undefined);
});
