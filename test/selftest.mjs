/**
 * Offline self-test for dsh-ntfy-push (`node test/selftest.mjs`).
 *
 * Boots a mock ntfy server, fakes the four DSH services the Host half touches,
 * then exercises: publish payload/auth header, approval reply (phone wins),
 * reply single-use + signature rejection, question option reply, UI-wins
 * fallback, and the authenticated settings API (GET / save / test).
 */
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

process.env.DSH_HOME = mkdtempSync(path.join(tmpdir(), 'dsh-ntfy-selftest-'));

const received = [];
const ntfy = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    received.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'),
    });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
});
await new Promise((resolve) => ntfy.listen(0, '127.0.0.1', resolve));
const port = ntfy.address().port;

const { apply } = await import('../index.js');

const webRoutes = [];
const listeners = new Map();
const secrets = new Map([['NTFY_PUSH_TOKEN', 'tk_selftest']]);
const contexts = {};

const ctx = {
  get(name) {
    return contexts[name];
  },
  effect(fn) {
    return fn();
  },
  on(name, fn, options) {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push({ fn, options });
    return () => {};
  },
};

contexts.connection = {
  fetch: {
    register(route) {
      webRoutes.push(route);
      return async () => {};
    },
  },
  authenticatedUrl(base) {
    return base + '/?token=selftest-token';
  },
};
contexts.credentials = {
  async resolve(ref) {
    return secrets.has(ref) ? { value: secrets.get(ref), source: 'test' } : undefined;
  },
  async describe(ref) {
    return { configured: secrets.has(ref), source: secrets.has(ref) ? 'test' : 'none', writable: true };
  },
  async set(ref, value) {
    secrets.set(ref, value);
  },
  async unset(ref) {
    secrets.delete(ref);
  },
};
contexts.webServer = {
  register(route) {
    webRoutes.push(route);
    return () => {};
  },
  getOrigin() {
    return 'http://127.0.0.1:3080';
  },
  tapIndex() {
    return () => {};
  },
};
contexts.webApp = {
  getAdvertisedUrl() {
    return 'https://dsh.example.test/';
  },
};
contexts.sessionTitle = {
  get() {
    return { title: '测试会话' };
  },
};

apply(ctx, {
  serverUrl: `http://127.0.0.1:${port}`,
  topic: 'selftest-topic',
  authMode: 'token',
  events: ['approval', 'question', 'turnEnd', 'error', 'subagent', 'workflow'],
  reply: { enabled: true, ttlSec: 120, webPromptDelaySec: 0 },
  minIntervalSec: 0,
});

const apiRoute = webRoutes.find((route) => route.path === '/api/dsh-ntfy-push');
const replyRoute = webRoutes.find((route) => route.path === '/dsh-ntfy-push');
assert.ok(apiRoute, 'settings API route registered');
assert.ok(replyRoute, 'reply route registered');

// Waterfall listeners must be prepended: the browser bridge registers first and
// otherwise claims every question/approval before this plugin is ever called.
for (const event of ['approval/request', 'user-questions/request']) {
  const entry = listeners.get(event)[0];
  assert.equal(entry.options?.prepend, true, `${event} listener is prepended`);
}

const settle = (ms = 250) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeReply(url) {
  const out = { status: 0, body: '' };
  return replyRoute.handler({ url, headers: { accept: 'application/json' } }, out).then(() => out);
}

// 1. approval: phone wins ---------------------------------------------------
{
  let answerNative;
  const native = new Promise((resolve) => {
    answerNative = resolve;
  });
  const handler = listeners.get('approval/request')[0].fn;
  const result = handler(
    { agent: { id: 'session-1', session: { events: [] } }, toolName: 'bash', reason: '要跑 rm -rf 前确认' },
    () => native,
  );
  await settle();
  const push = received.at(-1);
  assert.equal(push.method, 'POST');
  assert.equal(push.authorization, 'Bearer tk_selftest');
  assert.equal(push.body.topic, 'selftest-topic');
  assert.match(push.body.title, /需要你批准/);
  assert.equal(push.body.priority, 5);
  assert.equal(push.body.actions.length, 3);
  const allow = push.body.actions.find((action) => action.label === '批准');
  assert.ok(allow && allow.action === 'http' && allow.method === 'POST', 'approval http action');
  const page = await fakeReply(new URL(allow.url).pathname + new URL(allow.url).search);
  assert.equal(page.status, 200);
  assert.match(page.body, /approved|allowed-once|已批准/);
  const outcome = await result;
  assert.equal(outcome, 'allowed-once');
  answerNative('rejected'); // the browser prompt settling later must not matter

  const replay = await fakeReply(new URL(allow.url).pathname + new URL(allow.url).search);
  assert.equal(replay.status, 200, 'a repeat tap is idempotent');
  assert.match(replay.body, /已经处理过/, 'repeat tap explains it is settled');
}

// 2. signature rejection ----------------------------------------------------
{
  const tampered = '/dsh-ntfy-push/reply?t=eyJ4IjoxfQ.deadbeef';
  const page = await fakeReply(tampered);
  assert.equal(page.status, 403);
}

// 3. question: option button ------------------------------------------------
{
  const handler = listeners.get('user-questions/request')[0].fn;
  const result = handler(
    {
      agent: { id: 'session-2', session: { events: [] } },
      questions: [
        {
          id: 'q1',
          question: '选哪个部署方式？',
          options: [{ label: '容器内反代' }, { label: '改 bind' }],
        },
      ],
    },
    () => new Promise(() => {}),
  );
  await settle();
  const push = received.at(-1);
  assert.match(push.body.title, /等你回答/);
  const second = push.body.actions.find((action) => action.label === '改 bind');
  assert.ok(second, 'option action present');
  const page = await fakeReply(new URL(second.url).pathname + new URL(second.url).search);
  assert.equal(page.status, 200);
  const answer = await result;
  assert.deepEqual(answer, { answers: [{ id: 'q1', selected: ['改 bind'] }] });
}

// 3b. three options fill all three ntfy action slots (no redundant open) ----
{
  const handler = listeners.get('user-questions/request')[0].fn;
  const result = handler(
    {
      agent: { id: 'session-3opt', session: { events: [] } },
      questions: [
        {
          id: 'q3',
          question: '三选一',
          options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
        },
      ],
    },
    () => new Promise(() => {}),
  );
  await settle();
  const push = received.at(-1);
  assert.equal(push.body.actions.length, 3, 'three option actions');
  assert.equal(push.body.actions.filter((action) => action.action === 'http').length, 3, 'all three are http');
  assert.equal(push.body.actions.filter((action) => action.action === 'view').length, 0, 'no redundant open button');
  const b = push.body.actions.find((action) => action.label === 'B');
  const page = await fakeReply(new URL(b.url).pathname + new URL(b.url).search);
  assert.equal(page.status, 200);
  const answer = await result;
  assert.deepEqual(answer, { answers: [{ id: 'q3', selected: ['B'] }] });
}

// 4. UI wins ----------------------------------------------------------------
{
  const handler = listeners.get('approval/request')[0].fn;
  let answerNative;
  const native = new Promise((resolve) => {
    answerNative = resolve;
  });
  const result = handler({ agent: { id: 'session-3', session: { events: [] } }, toolName: 'write' }, () => native);
  answerNative('rejected');
  assert.equal(await result, 'rejected');
  await settle(50);
  const push = received.at(-1);
  assert.match(push.body.title, /需要你批准/);
}

// 5. authenticated settings API --------------------------------------------
{
  const get = await apiRoute.fetch(new Request('http://localhost/api/dsh-ntfy-push'));
  const state = await get.json();
  assert.equal(state.ok, true);
  assert.equal(state.configured, true);
  assert.equal(state.credential.token, true);
  assert.equal(state.replyReady, true);

  const save = await apiRoute.fetch(
    new Request('http://localhost/api/dsh-ntfy-push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'save', settings: { topic: 'other-topic' }, token: 'tk_new' }),
    }),
  );
  const saved = await save.json();
  assert.equal(saved.settings.topic, 'other-topic');
  assert.equal(secrets.get('NTFY_PUSH_TOKEN'), 'tk_new');

  const test = await apiRoute.fetch(
    new Request('http://localhost/api/dsh-ntfy-push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'test' }),
    }),
  );
  const tested = await test.json();
  assert.equal(tested.ok, true);
  assert.equal(received.at(-1).body.topic, 'other-topic');
  assert.match(received.at(-1).body.title, /测试/);
}

// 5b. click target modes ------------------------------------------------------
{
  const fire = async (sessionId) => {
    const status = listeners.get('agent/status')[0].fn;
    status({ agent: { id: sessionId, session: { events: [] } }, status: 'running' });
    status({ agent: { id: sessionId, session: { events: [] } }, status: 'idle' });
    await settle(150);
    return received.at(-1).body;
  };

  const tokenPush = await fire('session-click-a');
  const tokenTarget = new URL(tokenPush.click);
  assert.equal(tokenTarget.pathname, '/dsh-ntfy-push/open', 'click goes through the same-origin hop');
  assert.match(decodeURIComponent(tokenTarget.searchParams.get('u')), /token=selftest-token/, 'hop target carries the login token');

  await apiRoute.fetch(
    new Request('http://localhost/api/dsh-ntfy-push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'save', settings: { clickMode: 'none' } }),
    }),
  );
  const nonePush = await fire('session-click-b');
  assert.equal(nonePush.click, undefined, 'clickMode none sends no click');

  await apiRoute.fetch(
    new Request('http://localhost/api/dsh-ntfy-push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'save', settings: { clickMode: 'plain' } }),
    }),
  );
  const plainPush = await fire('session-click-c');
  const plainTarget = new URL(plainPush.click);
  assert.equal(plainTarget.pathname, '/dsh-ntfy-push/open', 'plain click is wrapped too');
  assert.equal(decodeURIComponent(plainTarget.searchParams.get('u')), 'https://dsh.example.test', 'plain target is the bare address');

  await apiRoute.fetch(
    new Request('http://localhost/api/dsh-ntfy-push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'save', settings: { clickMode: 'token' } }),
    }),
  );
}

// 5c. same-origin hop page -----------------------------------------------------
{
  const encoded = encodeURIComponent('https://dsh.example.test/?token=abc');
  const ok = await fakeReply(`/dsh-ntfy-push/open?u=${encoded}`);
  assert.equal(ok.status, 200);
  assert.match(ok.body, /location\.replace/, 'hop page redirects');
  assert.match(ok.body, /token=abc/, 'hop page carries the target');

  const offsite = await fakeReply(`/dsh-ntfy-push/open?u=${encodeURIComponent('https://evil.example/')}`);
  assert.equal(offsite.status, 400, 'hop refuses cross-origin targets');
}

// 5d. phone-first grace: the web answerer is not touched while the phone answers
{
  await apiRoute.fetch(
    new Request('http://localhost/api/dsh-ntfy-push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'save', settings: { reply: { webPromptDelaySec: 2 } } }),
    }),
  );

  let nativeCalls = 0;
  let answerNative;
  const nativePromise = new Promise((resolve) => {
    answerNative = resolve;
  });
  const handler = listeners.get('approval/request')[0].fn;
  const result = handler({ agent: { id: 'session-grace', session: { events: [] } }, toolName: 'bash' }, () => {
    nativeCalls += 1;
    return nativePromise;
  });
  await settle(200);
  const lastPush = received.at(-1);
  const allow = lastPush.body.actions.find((action) => action.label === '批准');
  const page = await fakeReply(new URL(allow.url).pathname + new URL(allow.url).search);
  assert.equal(page.status, 200);
  assert.equal(await result, 'allowed-once');
  await settle(2200);
  assert.equal(nativeCalls, 0, 'web answerer never started when the phone answered in time');
  answerNative('rejected');

  await apiRoute.fetch(
    new Request('http://localhost/api/dsh-ntfy-push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'save', settings: { reply: { webPromptDelaySec: 0 } } }),
    }),
  );
}

// 6. quiet hours: suppress turnEnd but let priority-5 approval through -------
{
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const from = `${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const to = `${pad((now.getHours() + 1) % 24)}:${pad(now.getMinutes())}`;
  await apiRoute.fetch(
    new Request('http://localhost/api/dsh-ntfy-push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'save', settings: { quietHours: { enabled: true, from, to, urgentBypass: true } } }),
    }),
  );

  const before = received.length;
  const status = listeners.get('agent/status')[0].fn;
  status({ agent: { id: 'session-quiet', session: { events: [] } }, status: 'running' });
  status({ agent: { id: 'session-quiet', session: { events: [] } }, status: 'idle' });
  await settle(150);
  assert.equal(received.length, before, 'quiet hours suppress turnEnd');

  const approval = listeners.get('approval/request')[0].fn;
  let answerNative;
  const native = new Promise((resolve) => {
    answerNative = resolve;
  });
  const pending = approval({ agent: { id: 'session-quiet', session: { events: [] } }, toolName: 'bash' }, () => native);
  await settle(150);
  assert.equal(received.length, before + 1, 'urgent approval bypasses quiet hours');
  answerNative('rejected');
  await pending;
}

ntfy.close();
console.log('selftest: all assertions passed');