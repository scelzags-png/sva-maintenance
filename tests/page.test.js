// Browser test of the page with a fake Apps Script. Run: node tests/page.test.js
// (needs Playwright; serves this folder on a local port).
const { chromium } = require(process.env.PW_PATH || 'playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) pass++; else { fail++; console.log('FAIL', n, x === undefined ? '' : x); } };

function serve() {
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
  const srv = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html');
    fs.readFile(p.endsWith(path.sep) ? p + 'index.html' : p, (err, data) => {
      if (err) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise(r => srv.listen(0, () => r(srv)));
}

const LINK = 'a'.repeat(64), TOKEN = 'b'.repeat(64), REVOKE = 'c'.repeat(64);

function fakeServer() {
  const st = { calls: [], mode: 'normal', requests: [
    { id: 'MR-0001', created: Date.now() - 2 * 864e5, email: 'tim.harley@svasda.org', name: 'Tim Harley', building: 'Administration Building', spot: 'Room 201', category: 'Plumbing', desc: 'Sink drips', hasPhoto: false, priority: 'Normal', status: 'New', assigned: '', notes: '', updated: Date.now(), closed: 0, safety: false, entryOk: false }
  ] };
  const state = () => ({ api: 3, me: { name: 'Tim Harley', email: 'tim.harley@svasda.org', role: 'requester', building: 'Administration Building', room: 'Room 201', also: [] },
    locations: [{ name: 'Administration Building', rooms: ['Room 201', 'Room 202'], urgent: false }, { name: 'Vehicles', rooms: ['Mini Bus 1', 'Mini Bus 2'], urgent: false }],
    categories: ['Plumbing', 'Electrical and lights', 'Vehicle'], statuses: ['New', 'In progress', 'Waiting on parts', 'Done', 'Canceled'], priorities: ['Normal', 'Urgent'],
    requests: st.requests });
  st.handle = (body) => {
    st.calls.push(body);
    if (st.mode === 'update') return { ok: false, api: 3, error: 'UPDATE' };
    const a = body.args || [];
    const authed = body.token === TOKEN;
    switch (body.fn) {
      case 'requestLink': return { ok: true, api: 3, data: { ok: true, message: 'If that address is on the staff list, a sign-in link is on its way.' } };
      case 'redeemLink': return a[0] === LINK ? { ok: true, api: 3, data: { ok: true, token: TOKEN, state: state() } } : { ok: true, api: 3, data: { ok: false, message: 'That sign-in link expired or was already used. Request a new one.' } };
      case 'revokeAll': return { ok: true, api: 3, data: { ok: a[0] === REVOKE, message: a[0] === REVOKE ? 'Done. You are signed out on every device.' : 'That link is not valid.' } };
      case 'signOut': return { ok: true, api: 3, data: { ok: true } };
    }
    if (!authed) return { ok: false, api: 3, auth: true, error: 'Please sign in again.' };
    switch (body.fn) {
      case 'bootstrap': return { ok: true, api: 3, data: state() };
      case 'findSimilar': return { ok: true, api: 3, data: a[1] === 'Plumbing' ? [{ id: 'MR-0001', spot: 'Room 201', status: 'New', days: 2, desc: 'Sink drips', sameSpot: true }] : [] };
      case 'createRequest': {
        const d = a[0];
        const obj = { id: 'MR-0002', created: Date.now(), email: 'tim.harley@svasda.org', name: 'Tim Harley', building: d.building, spot: d.spot, category: d.category, desc: d.description, hasPhoto: false,
          priority: d.safety === true ? 'Urgent' : 'Normal', status: 'New', assigned: '', notes: '', updated: Date.now(), closed: 0, safety: d.safety === true, entryOk: d.entryOk === true };
        st.requests.unshift(obj);
        return { ok: true, api: 3, data: obj };
      }
    }
    return { ok: false, api: 3, error: 'Unknown action.' };
  };
  return st;
}

async function newPage(browser, base, st, opts) {
  const ctx = await browser.newContext(opts || {});
  const page = await ctx.newPage();
  page.errors = [];
  page.on('pageerror', e => page.errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error' && !/fonts\.g/.test(m.text()) && !/ERR_|Failed to load resource/.test(m.text())) page.errors.push(m.text()); });
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('https://script.google.com/**', async r => {
    const req = r.request();
    ok('POST text/plain', req.method() === 'POST' && /text\/plain/.test(req.headers()['content-type'] || ''), req.headers()['content-type']);
    const body = JSON.parse(req.postData() || '{}');
    await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(st.handle(body)) });
  });
  return { ctx, page };
}

(async () => {
  const srv = await serve();
  const base = 'http://localhost:' + srv.address().port + '/';
  const browser = await chromium.launch();

  // 1. First visit: sign-in screen, request a link
  let st = fakeServer();
  let { ctx, page } = await newPage(browser, base, st);
  await page.goto(base);
  await page.waitForSelector('#auth:not([hidden])');
  ok('auth shown', await page.isVisible('#authStep1'));
  ok('no code field', (await page.$('#authCode')) === null);
  ok('safety note shown', /never|Nobody from the school/i.test(await page.textContent('.safe-note')));
  await page.fill('#authEmail', 'tim.harley@svasda.org');
  await page.click('#sendLink');
  await page.waitForSelector('#authStep2:not([hidden])');
  const rl = st.calls.find(c => c.fn === 'requestLink');
  ok('requestLink sends only the email', rl && rl.args.length === 1 && rl.args[0] === 'tim.harley@svasda.org' && !rl.token, rl);
  ok('level sent', rl.level === 3);
  ok('manifest added on desktop/Android', await page.$('link[rel=manifest]') !== null);
  await ctx.close();

  // 2. Opening the sign-in link: needs a tap, hash removed from address
  st = fakeServer();
  ({ ctx, page } = await newPage(browser, base, st));
  await page.goto(base + '#signin=' + LINK);
  await page.waitForSelector('#authConfirm:not([hidden])');
  ok('hash cleared from address', !(await page.evaluate(() => location.hash)), await page.evaluate(() => location.href));
  ok('no redeem before tap', !st.calls.some(c => c.fn === 'redeemLink'));
  await page.click('#confirmSignIn');
  await page.waitForSelector('#shell:not([hidden])');
  const rd = st.calls.find(c => c.fn === 'redeemLink');
  ok('redeem sends link + device', rd.args[0] === LINK && /Chrome|browser/.test(rd.args[1]), rd.args);
  ok('token stored', (await page.evaluate(() => localStorage.getItem('svam_token'))) === TOKEN);
  ok('own request listed', /Sink drips/.test(await page.textContent('#list')));

  // 3. Reload keeps the session (first-party storage)
  await page.reload();
  await page.waitForSelector('#shell:not([hidden])');
  ok('session kept after reload', true);
  const bs = st.calls.filter(c => c.fn === 'bootstrap').pop();
  ok('bootstrap carries token', bs.token === TOKEN);

  // 4. New request: similar warning, safety, vehicle label
  await page.click('#fab');
  await page.waitForSelector('#nrDesc');
  await page.click('#nrCats .pick[data-v="Plumbing"]');
  await page.waitForSelector('.similar');
  ok('similar shown', /MR-0001/.test(await page.textContent('#nrSimilar')));
  ok('similar has no names', !/Tim Harley/.test(await page.textContent('#nrSimilar')));
  await page.click('#nrCats .pick[data-v="Electrical and lights"]');
  await page.waitForFunction(() => !document.querySelector('.similar'));
  ok('similar cleared for other category', true);
  await page.selectOption('#nrBuilding', 'Vehicles');
  ok('vehicle label', /Which vehicle/.test(await page.textContent('#nrSpotWrap')));
  await page.selectOption('#nrSpot', 'Mini Bus 2');
  await page.fill('#nrDesc', 'Dash light is sparking');
  await page.check('#nrSafety');
  const draft = JSON.parse(await page.evaluate(() => localStorage.getItem('svam_draft')));
  ok('draft keeps safety', draft.safety === true, draft);
  await page.click('#nrSubmit');
  await page.waitForSelector('#modal[hidden]', { state: 'attached' });
  const cr = st.calls.find(c => c.fn === 'createRequest').args[0];
  ok('create sends booleans', cr.safety === true && cr.entryOk === undefined && cr.building === 'Vehicles' && cr.spot === 'Mini Bus 2', cr);
  ok('safety badge on card', /Safety/.test(await page.textContent('#list')));
  ok('draft cleared', (await page.evaluate(() => localStorage.getItem('svam_draft'))) === null);
  await page.click('.card[data-id="MR-0002"]');
  ok('detail shows safety, no entry row', !/OK to enter/.test(await page.textContent('#pane')) && /safety problem/.test(await page.textContent('#pane')));

  // 5. Server says the page is too old -> updating screen, draft saved
  await page.click('[data-act="closePane"]');
  await page.click('#fab');
  await page.fill('#nrDesc', 'Half typed');
  st.mode = 'update';
  await page.click('#nrCats .pick[data-v="Plumbing"]');
  await page.waitForSelector('#updating:not([hidden])');
  ok('updating screen', await page.isVisible('#updating'));
  ok('draft saved during update', /Half typed/.test(await page.evaluate(() => localStorage.getItem('svam_draft'))));
  st.mode = 'normal';

  // 6. Expired session -> sign-in
  await page.evaluate(() => localStorage.setItem('svam_token', 'x'.repeat(64)));
  await page.goto(base);
  await page.waitForSelector('#auth:not([hidden])');
  ok('bad token -> sign in', /sign in again/i.test(await page.textContent('#authErr')));
  ok('no JS errors', page.errors.length === 0, page.errors);
  await ctx.close();

  // 7. Used/expired link shows message
  st = fakeServer();
  ({ ctx, page } = await newPage(browser, base, st));
  await page.goto(base + '#signin=' + 'd'.repeat(64));
  await page.click('#confirmSignIn');
  await page.waitForSelector('#authErr:not([hidden])');
  ok('expired link message', /expired or was already used/.test(await page.textContent('#authErr')));
  await ctx.close();

  // 8. Sign out everywhere link
  st = fakeServer();
  ({ ctx, page } = await newPage(browser, base, st));
  await page.goto(base);
  await page.evaluate(t => localStorage.setItem('svam_token', t), TOKEN);
  await page.goto(base + '#revoke=' + REVOKE);
  await page.waitForSelector('#authRevoke:not([hidden])');
  ok('no revoke before tap', !st.calls.some(c => c.fn === 'revokeAll'));
  await page.click('#confirmRevoke');
  await page.waitForSelector('#authStep1:not([hidden])');
  ok('revoke called', st.calls.some(c => c.fn === 'revokeAll' && c.args[0] === REVOKE));
  ok('local token removed', (await page.evaluate(() => localStorage.getItem('svam_token'))) === null);
  await ctx.close();

  // 9. Junk in the hash is ignored
  st = fakeServer();
  ({ ctx, page } = await newPage(browser, base, st));
  await page.goto(base + '#signin=<img src=x onerror=alert(1)>');
  await page.waitForSelector('#authStep1:not([hidden])');
  ok('junk hash ignored', !st.calls.some(c => c.fn === 'redeemLink'));
  await ctx.close();

  // 10. iPhone: no manifest (icon opens in Safari)
  st = fakeServer();
  ({ ctx, page } = await newPage(browser, base, st, { userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 800 } }));
  await page.goto(base);
  await page.waitForSelector('#auth:not([hidden])');
  ok('no manifest on iPhone', (await page.$('link[rel=manifest]')) === null);
  await page.goto(base + '#signin=' + LINK);
  await page.click('#confirmSignIn');
  await page.waitForSelector('#shell:not([hidden])');
  const rd2 = st.calls.find(c => c.fn === 'redeemLink');
  ok('device label iPhone', rd2.args[1] === 'Safari on iPhone', rd2.args[1]);
  const fs16 = await page.evaluate(() => { document.querySelector('#fab').click(); return getComputedStyle(document.querySelector('#nrDesc')).fontSize; });
  ok('fields 16px on phone', fs16 === '16px', fs16);
  await page.screenshot({ path: '/tmp/phone-form.png', fullPage: false });
  await ctx.close();

  await browser.close();
  srv.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
