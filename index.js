/**
 * Host half of `dsh-ntfy-push`.
 *
 * Pushes DeepSeek Harness task events to any ntfy server (self-hosted URL, with
 * `none` / `token` / `basic` authentication) and lets the phone answer an
 * approval or a user question directly from the notification:
 *
 *   - `approval/request` and `user-questions/request` are waterfalls. We start
 *     the native answerer (`next()`) so the browser prompt still appears, push a
 *     notification carrying one-time HMAC-signed action URLs, and return
 *     whichever side settles first.
 *   - The action URL hits the raw `/dsh-ntfy-push/reply` route. That route is
 *     NOT behind the `/api` browser authentication on purpose: a phone cannot
 *     carry the DSH login. Authorization is the signed token itself — HMAC over
 *     `{nonce, expiry, kind, value}`, single use, bound to one pending request.
 *
 * Secrets never leave this process: the ntfy token and basic password live in
 * the DSH credential store and are only read to build the outgoing header.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Order the plugin after the services it needs. */
export const inject = ['connection', 'credentials'];

const PLUGIN = 'dsh-ntfy-push';
const API_ROUTE = '/api/dsh-ntfy-push';
const REPLY_PREFIX = '/dsh-ntfy-push';
const REPLY_ROUTE = `${REPLY_PREFIX}/reply`;
const BOOT_GLOBAL = '__DSH_NTFY_PUSH_BOOT__';

const EVENT_KINDS = ['approval', 'question', 'turnEnd', 'error', 'subagent', 'workflow'];
const INTERACTIVE = new Set(['approval', 'question']);
const AUTH_MODES = ['none', 'token', 'basic'];

const DEFAULT_PRIORITY = { approval: 5, question: 4, turnEnd: 3, error: 5, subagent: 2, workflow: 2 };
const DEFAULT_TAGS = {
  approval: ['rotating_light'],
  question: ['question'],
  turnEnd: ['heavy_check_mark'],
  error: ['warning'],
  subagent: ['arrow_forward'],
  workflow: ['arrow_forward'],
};

const REQUEST_TIMEOUT_MS = 12_000;
const MAX_POST_BYTES = 64 * 1024;
const MAX_MESSAGE_CHARS = 1200;
const MAX_TITLE_CHARS = 200;
const PREVIEW_CHARS = 160;
const MAX_ACTIONS = 3;

const DEFAULTS = {
  serverUrl: 'https://ntfy.sh',
  topic: '',
  authMode: 'token',
  tokenRef: 'NTFY_PUSH_TOKEN',
  passwordRef: 'NTFY_PUSH_PASSWORD',
  username: '',
  events: [...EVENT_KINDS],
  priority: { ...DEFAULT_PRIORITY },
  tags: { ...DEFAULT_TAGS },
  clickTemplate: '',
  clickMode: 'token',
  reply: { enabled: true, ttlSec: 600, webPromptDelaySec: 0 },
  quietHours: { enabled: false, from: '23:00', to: '08:00', urgentBypass: true },
  minIntervalSec: 20,
  includePreview: true,
};

// ---------------------------------------------------------------------------
// config: Standard Schema v1, tolerant by design
// ---------------------------------------------------------------------------

const asString = (value) => (typeof value === 'string' ? value.trim() : '');
const asBool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
const asNumber = (value, fallback, min, max) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};
const asClock = (value, fallback) => {
  const text = asString(value);
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(text) ? text : fallback;
};

function mergeConfig(base, partial) {
  const input = partial && typeof partial === 'object' ? partial : {};
  return {
    ...base,
    ...input,
    priority: { ...base.priority, ...(input.priority && typeof input.priority === 'object' ? input.priority : {}) },
    tags: { ...base.tags, ...(input.tags && typeof input.tags === 'object' ? input.tags : {}) },
    reply: { ...base.reply, ...(input.reply && typeof input.reply === 'object' ? input.reply : {}) },
    quietHours: { ...base.quietHours, ...(input.quietHours && typeof input.quietHours === 'object' ? input.quietHours : {}) },
  };
}

/**
 * Accept any object and fill every documented default; unknown keys are
 * dropped. The panel writes a partial settings document, so strict rejection
 * would make a half-filled row fail to activate.
 */
export const Config = {
  vendor: PLUGIN,
  version: 1,
  '~standard': {
    validate(value) {
      if (value !== undefined && value !== null && typeof value !== 'object') {
        return { issues: [{ message: 'config must be an object', path: [] }] };
      }
      return { value: normalizeConfig(value) };
    },
  },
};

function normalizeConfig(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const events = Array.isArray(input.events)
    ? input.events.filter((kind) => EVENT_KINDS.includes(kind))
    : [...DEFAULTS.events];
  const priority = {};
  const tags = {};
  for (const kind of EVENT_KINDS) {
    priority[kind] = Math.round(asNumber(input.priority?.[kind], DEFAULT_PRIORITY[kind], 1, 5));
    const list = input.tags?.[kind];
    tags[kind] = Array.isArray(list)
      ? list.map((tag) => asString(tag)).filter(Boolean).slice(0, 8)
      : [...DEFAULT_TAGS[kind]];
  }
  return {
    serverUrl: asString(input.serverUrl) || DEFAULTS.serverUrl,
    topic: asString(input.topic),
    authMode: AUTH_MODES.includes(input.authMode) ? input.authMode : DEFAULTS.authMode,
    tokenRef: asString(input.tokenRef) || DEFAULTS.tokenRef,
    passwordRef: asString(input.passwordRef) || DEFAULTS.passwordRef,
    username: asString(input.username),
    events,
    priority,
    tags,
    clickTemplate: asString(input.clickTemplate),
    clickMode: ['token', 'plain', 'none'].includes(input.clickMode) ? input.clickMode : DEFAULTS.clickMode,
    reply: {
      enabled: asBool(input.reply?.enabled, DEFAULTS.reply.enabled),
      ttlSec: Math.round(asNumber(input.reply?.ttlSec, DEFAULTS.reply.ttlSec, 30, 86_400)),
      webPromptDelaySec: Math.round(asNumber(input.reply?.webPromptDelaySec, DEFAULTS.reply.webPromptDelaySec, 0, 60)),
    },
    quietHours: {
      enabled: asBool(input.quietHours?.enabled, DEFAULTS.quietHours.enabled),
      from: asClock(input.quietHours?.from, DEFAULTS.quietHours.from),
      to: asClock(input.quietHours?.to, DEFAULTS.quietHours.to),
      urgentBypass: asBool(input.quietHours?.urgentBypass, DEFAULTS.quietHours.urgentBypass),
    },
    minIntervalSec: Math.round(asNumber(input.minIntervalSec, DEFAULTS.minIntervalSec, 0, 3600)),
    includePreview: asBool(input.includePreview, DEFAULTS.includePreview),
  };
}

// ---------------------------------------------------------------------------
// state files: runtime settings + HMAC secret
// ---------------------------------------------------------------------------

const homeDir = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const stateDir = path.join(homeDir, PLUGIN);
const SETTINGS_FILE = path.join(stateDir, 'settings.json');
const SECRET_FILE = path.join(stateDir, 'hmac.key');

function describeError(error) {
  if (!error) return 'unknown error';
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 300 ? `${message.slice(0, 300)}…` : message;
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

async function writePrivateFile(file, text) {
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, text, { mode: 0o600 });
  await fs.rename(temp, file);
  await fs.chmod(file, 0o600).catch(() => {});
}

/**
 * Runtime store: the patch config is the default layer, `settings.json` the
 * panel-written override layer. The secret is generated once and never leaves
 * this directory.
 */
function createStore(patchConfig) {
  // The HMAC secret and the panel overrides are read synchronously at
  // activation: a reply token must never be signed with a different secret
  // than the one the route verifies with, even in the first milliseconds.
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(stateDir, 0o700);
  } catch {
    /* not fatal */
  }

  let secret = null;
  try {
    const text = readFileSync(SECRET_FILE, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(text)) secret = Buffer.from(text, 'hex');
  } catch {
    /* first run */
  }
  if (!secret) {
    secret = randomBytes(32);
    try {
      writeFileSync(SECRET_FILE, secret.toString('hex'), { mode: 0o600 });
      chmodSync(SECRET_FILE, 0o600);
    } catch (error) {
      console.warn(`[${PLUGIN}] cannot persist the reply secret: ${describeError(error)}`);
    }
  }

  let settings = patchConfig;
  try {
    const saved = JSON.parse(readFileSync(SETTINGS_FILE, 'utf8'));
    if (saved && typeof saved === 'object') settings = normalizeConfig(mergeConfig(patchConfig, saved));
  } catch {
    /* first run or a hand-edited file: keep the patch layer */
  }

  return {
    ensure() {
      return undefined;
    },
    get current() {
      return settings;
    },
    get secret() {
      return secret;
    },
    async save(partial) {
      settings = normalizeConfig(mergeConfig(settings, partial));
      await writePrivateFile(SETTINGS_FILE, `${JSON.stringify(settings, null, 2)}\n`);
      return settings;
    },
  };
}
// ---------------------------------------------------------------------------
// credentials
// ---------------------------------------------------------------------------

async function resolveSecret(ctx, ref) {
  const credentials = ctx.get('credentials');
  if (!credentials || typeof credentials.resolve !== 'function') return '';
  try {
    const resolved = await credentials.resolve(ref);
    return typeof resolved?.value === 'string' ? resolved.value.trim() : '';
  } catch {
    return '';
  }
}

async function describeSecret(ctx, ref) {
  const credentials = ctx.get('credentials');
  if (!credentials || typeof credentials.describe !== 'function') return { configured: false, source: 'none' };
  try {
    const described = await credentials.describe(ref);
    return {
      configured: described?.configured === true,
      source: typeof described?.source === 'string' ? described.source : described?.configured ? 'credential' : 'none',
    };
  } catch {
    return { configured: false, source: 'none' };
  }
}

async function authHeader(ctx, cfg) {
  if (cfg.authMode === 'none') return null;
  if (cfg.authMode === 'token') {
    const token = await resolveSecret(ctx, cfg.tokenRef);
    return token ? `Bearer ${token}` : null;
  }
  const password = await resolveSecret(ctx, cfg.passwordRef);
  if (!password) return null;
  return `Basic ${Buffer.from(`${cfg.username || ''}:${password}`, 'utf8').toString('base64')}`;
}

// ---------------------------------------------------------------------------
// public base URL, click target, reply URLs
// ---------------------------------------------------------------------------

function publicBase(ctx) {
  try {
    const advertised = ctx.get('webApp')?.getAdvertisedUrl?.();
    if (typeof advertised === 'string' && advertised) return advertised.replace(/\/+$/, '');
  } catch {
    /* fall through */
  }
  try {
    const origin = ctx.get('webServer')?.getOrigin?.();
    if (typeof origin === 'string' && origin) return origin.replace(/\/+$/, '');
  } catch {
    /* fall through */
  }
  const env = (process.env.DSH_WEB_URL || '').trim();
  return env ? env.replace(/\/+$/, '') : '';
}

/**
 * Notification click target.
 *
 *  - `clickTemplate` wins when set (custom URL, `{sessionId}`/`{title}` placeholders)
 *  - `clickMode: 'token'` (default) appends the fresh process token through
 *    `connection.authenticatedUrl`, so tapping on a phone that has never logged
 *    in opens DSH already authenticated (the token rotates on every restart)
 *  - `clickMode: 'plain'` opens the bare DSH address (phone needs a live cookie)
 *  - `clickMode: 'none'` sends no click target at all
 */
function clickTarget(ctx, cfg, sessionId, title) {
  const template = cfg.clickTemplate.trim();
  if (template) {
    return template
      .replace(/\{sessionId\}/g, encodeURIComponent(sessionId || ''))
      .replace(/\{title\}/g, encodeURIComponent(title || ''));
  }
  if (cfg.clickMode === 'none') return undefined;
  const base = publicBase(ctx);
  if (!base) return undefined;
  let target = base;
  if (cfg.clickMode === 'token') {
    try {
      const url = ctx.get('connection')?.authenticatedUrl?.(base);
      if (typeof url === 'string' && url) target = url;
    } catch {
      /* fall back to the bare address */
    }
  }
  // Route the tap through our same-origin hop page: DSH's login cookie is
  // SameSite=Strict, so a redirect chain started by another app (the ntfy
  // notification) drops the freshly minted cookie on the 303 and lands on 401.
  // Loading the hop page first makes the token navigation same-site.
  return `${base}${REPLY_PREFIX}/open?u=${encodeURIComponent(target)}`;
}

// ---------------------------------------------------------------------------
// one-time signed reply tokens
// ---------------------------------------------------------------------------

const signPayload = (secret, payload) => createHmac('sha256', secret).update(payload).digest('base64url');

function makeToken(secret, { nonce, kind, value, ttlSec }) {
  const payload = Buffer.from(
    JSON.stringify({ n: nonce, e: Math.floor(Date.now() / 1000) + ttlSec, k: kind, v: value }),
  ).toString('base64url');
  return `${payload}.${signPayload(secret, payload)}`;
}

/** Verify signature and expiry; returns `{payload}` or `{error}`. */
function verifyToken(secret, token) {
  const text = typeof token === 'string' ? token.trim() : '';
  const dot = text.lastIndexOf('.');
  if (dot <= 0 || dot === text.length - 1) return { error: 'bad-token' };
  const payload = text.slice(0, dot);
  const left = Buffer.from(text.slice(dot + 1));
  const right = Buffer.from(signPayload(secret, payload));
  if (left.length !== right.length || !timingSafeEqual(left, right)) return { error: 'bad-signature' };
  let body;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { error: 'bad-token' };
  }
  if (!body || typeof body !== 'object') return { error: 'bad-token' };
  if (typeof body.e !== 'number' || body.e * 1000 < Date.now()) return { error: 'expired' };
  return { payload: body };
}

// ---------------------------------------------------------------------------
// ntfy delivery
// ---------------------------------------------------------------------------

function clampText(value, max) {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Publish one JSON message. Never throws; resolves a delivery receipt.
 * Plain `fetch` from the Host process, so a private/LAN/tailnet ntfy works —
 * there is intentionally no SSRF allow-list here: the server is the user's own.
 */
async function publish(ctx, cfg, message) {
  if (!cfg.serverUrl || !cfg.topic) return { ok: false, error: 'not-configured' };
  const base = cfg.serverUrl.replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) return { ok: false, error: 'bad-server-url' };
  const headers = { 'content-type': 'application/json; charset=utf-8' };
  const auth = await authHeader(ctx, cfg);
  if (auth) headers.authorization = auth;
  else if (cfg.authMode !== 'none') return { ok: false, error: 'missing-credential' };

  const body = {
    topic: cfg.topic,
    title: clampText(message.title, MAX_TITLE_CHARS),
    message: clampText(message.message, MAX_MESSAGE_CHARS),
    priority: Math.round(message.priority || 3),
    tags: message.tags?.length ? message.tags : undefined,
    click: message.click || undefined,
    actions: message.actions?.length ? message.actions.slice(0, MAX_ACTIONS) : undefined,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${base}/`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text().catch(() => '');
    return {
      ok: response.ok,
      httpStatus: response.status,
      detail: response.ok ? `HTTP ${response.status}` : `HTTP ${response.status} ${clampText(text, 160)}`,
    };
  } catch (error) {
    return { ok: false, error: controller.signal.aborted ? 'timeout' : describeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// time / quiet hours / rate limiting
// ---------------------------------------------------------------------------

const parseClock = (text) => {
  const match = /^(\d{2}):(\d{2})$/.exec(text || '');
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

function insideQuietHours(cfg) {
  const quiet = cfg.quietHours;
  if (!quiet.enabled) return false;
  const from = parseClock(quiet.from);
  const to = parseClock(quiet.to);
  if (from === null || to === null || from === to) return false;
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

// ---------------------------------------------------------------------------
// pending replies (approval / question)
// ---------------------------------------------------------------------------

function createPendingRegistry() {
  const entries = new Map(); // nonce → entry
  const live = new Set();

  function begin(kind, ttlSec) {
    let settle;
    const promise = new Promise((resolve) => {
      settle = resolve;
    });
    const entry = {
      kind,
      tokens: [],
      promise,
      settled: false,
      question: null,
      timer: null,
      resolve: (value) => {
        if (entry.settled) return;
        entry.settled = true;
        discard(entry);
        settle(value);
      },
    };
    entry.timer = setTimeout(() => entry.resolve(null), Math.max(30, ttlSec) * 1000);
    entry.timer.unref?.();
    live.add(entry);
    return entry;
  }

  function register(entry, nonce) {
    entry.tokens.push(nonce);
    entries.set(nonce, entry);
  }

  function discard(entry) {
    if (entry.timer) clearTimeout(entry.timer);
    live.delete(entry);
    for (const nonce of entry.tokens) entries.delete(nonce);
  }

  function cancel(entry) {
    if (!entry || entry.settled) return;
    entry.settled = true;
    discard(entry);
    entry.resolve(null);
  }

  /** Consume one nonce atomically; returns `{entry}` or `{error}`. */
  function consume(nonce) {
    const entry = entries.get(nonce);
    if (!entry || entry.settled) {
      if (entry) discard(entry);
      return { error: 'used-or-unknown' };
    }
    return { entry };
  }

  function shutdown() {
    for (const entry of [...live]) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.settled = true;
      discard(entry);
    }
  }

  return { begin, register, cancel, consume, shutdown };
}

/** Create a signed token plus the nonce it carries. */
function issueToken(secret, kind, value, ttlSec) {
  const nonce = randomBytes(16).toString('hex');
  return { nonce, token: makeToken(secret, { nonce, kind, value, ttlSec }) };
}

// ---------------------------------------------------------------------------
// notification text helpers
// ---------------------------------------------------------------------------

function sessionTitleOf(ctx, agent) {
  try {
    const snapshot = ctx.get('sessionTitle')?.get?.(agent?.session);
    if (snapshot && typeof snapshot.title === 'string' && snapshot.title.trim()) return snapshot.title.trim();
  } catch {
    /* titles are optional */
  }
  return '未命名会话';
}

function lastAssistantText(session) {
  const events = session?.events;
  if (!Array.isArray(events)) return '';
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!event || event.type !== 'assistant/message') continue;
    const content = event.message?.content ?? event.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join(' ')
      .trim();
    if (text) return text;
  }
  return '';
}

// ---------------------------------------------------------------------------
// plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx, config) {
  const store = createStore(normalizeConfig(config));
  const pending = createPendingRegistry();
  const lastSent = new Map();
  const previousStatus = new Map();
  const state = { lastDelivery: null };

  const record = (kind, receipt) => {
    state.lastDelivery = {
      at: Date.now(),
      event: kind,
      ok: receipt.ok === true,
      detail: receipt.detail || receipt.error || '',
    };
  };

  async function deliver(kind, cfg, message) {
    const receipt = await publish(ctx, cfg, message);
    record(kind, receipt);
    if (!receipt.ok) console.warn(`[${PLUGIN}] ${kind} push failed: ${receipt.detail || receipt.error}`);
    return receipt;
  }

  function shouldSend(cfg, kind, priority, sessionId) {
    if (!cfg.events.includes(kind)) return false;
    if (!cfg.serverUrl || !cfg.topic) return false;
    if (insideQuietHours(cfg) && !(cfg.quietHours.urgentBypass && priority >= 5)) return false;
    if (!INTERACTIVE.has(kind) && cfg.minIntervalSec > 0) {
      const key = `${sessionId}:${kind}`;
      const now = Date.now();
      const last = lastSent.get(key) || 0;
      if (now - last < cfg.minIntervalSec * 1000) return false;
      lastSent.set(key, now);
    }
    return true;
  }

  function replyActions(cfg, items) {
    if (!cfg.reply.enabled) return [];
    const base = publicBase(ctx);
    if (!base) return [];
    return items.slice(0, MAX_ACTIONS).map((item) => {
      const url = `${base}${REPLY_ROUTE}?t=${encodeURIComponent(item.token)}`;
      return { action: 'http', label: item.label, url, method: 'POST', clear: true };
    });
  }

  function openActions(ctx, cfg, sessionId, title) {
    const url = clickTarget(ctx, cfg, sessionId, title);
    return url ? [{ action: 'view', label: '打开 DSH', url }] : [];
  }

  // -- approval -------------------------------------------------------------

  async function onApproval(request, next) {
    let nativeRaw = null;
    let native = null;
    const startNative = () => {
      if (nativeRaw) return native;
      nativeRaw = next();
      native = nativeRaw.then(
        (value) => ({ source: 'ui', value }),
        (error) => ({ source: 'ui-error', error }),
      );
      return native;
    };
    const cfg = store.current;
    const send = shouldSend(cfg, 'approval', cfg.priority.approval, request?.agent?.id || '');
    console.log(`[${PLUGIN}] approval request: tool=${typeof request?.toolName === 'string' ? request.toolName : '?'} send=${send}`);
    if (!send) return startNative() && nativeRaw;

    const title = sessionTitleOf(ctx, request?.agent);
    const toolName = typeof request?.toolName === 'string' ? request.toolName : '工具调用';
    let entry = null;
    try {
      entry = pending.begin('approval', cfg.reply.ttlSec);
      const allow = issueToken(store.secret, 'approval', 'allowed-once', cfg.reply.ttlSec);
      const refuse = issueToken(store.secret, 'approval', 'rejected', cfg.reply.ttlSec);
      pending.register(entry, allow.nonce);
      pending.register(entry, refuse.nonce);

      void deliver('approval', cfg, {
        title: `需要你批准：${clampText(toolName, 60)}`,
        message: [`会话：${title}`, request?.reason ? `理由：${clampText(request.reason, 300)}` : '', '', '可直接在通知上批准或拒绝。']
          .filter((line) => line !== '')
          .join('\n'),
        priority: cfg.priority.approval,
        tags: cfg.tags.approval,
        click: clickTarget(ctx, cfg, request?.agent?.id, title),
        actions: [...replyActions(cfg, [{ token: allow.token, label: '批准' }, { token: refuse.token, label: '拒绝' }]), ...openActions(ctx, cfg, request?.agent?.id, title)].slice(0, MAX_ACTIONS),
      });

      // Give the notification a head start: if the phone answers inside this
      // window the web prompt is never shown, so no stale card is left behind.
      const graceMs = Math.max(0, Number(cfg.reply.webPromptDelaySec ?? 0) * 1000);
      const early = await Promise.race([
        entry.promise.then((value) => (value ? { source: 'phone', value } : null)),
        new Promise((resolve) => setTimeout(() => resolve({ source: 'grace' }), graceMs)),
      ]);
      if (early && early.source === 'phone') {
        console.log(`[${PLUGIN}] grace hit: answered on the phone, web prompt never shown`);
        return early.value;
      }
      console.log(`[${PLUGIN}] grace expired: showing the web prompt too`);
      startNative();
      const winner = await Promise.race([
        native,
        entry.promise.then((value) => (value ? { source: 'phone', value } : null)),
      ]);
      if (winner && winner.source === 'phone') {
        nativeRaw.catch(() => {});
        return winner.value;
      }
      if (winner && winner.source === 'ui') {
        pending.cancel(entry);
        return winner.value;
      }
      if (winner && winner.source === 'ui-error') {
        pending.cancel(entry);
        throw winner.error;
      }
      const settled = await native;
      pending.cancel(entry);
      if (settled.source === 'ui') return settled.value;
      throw settled.error ?? new Error('approval answerer failed');
    } catch (error) {
      pending.cancel(entry);
      const settled = await (native ?? startNative()).catch((inner) => ({ source: 'ui-error', error: inner }));
      if (settled.source === 'ui') return settled.value;
      throw settled.error ?? error;
    }
  }

  // -- user question --------------------------------------------------------

  async function onQuestion(request, next) {
    let nativeRaw = null;
    let native = null;
    const startNative = () => {
      if (nativeRaw) return native;
      nativeRaw = next();
      native = nativeRaw.then(
        (value) => ({ source: 'ui', value }),
        (error) => ({ source: 'ui-error', error }),
      );
      return native;
    };
    const cfg = store.current;
    const first = Array.isArray(request?.questions) ? request.questions[0] : null;
    const send = Boolean(first) && shouldSend(cfg, 'question', cfg.priority.question, request?.agent?.id || '');
    console.log(`[${PLUGIN}] question request: questions=${Array.isArray(request?.questions) ? request.questions.length : 0} send=${send}`);
    if (!send) return startNative() && nativeRaw;

    const title = sessionTitleOf(ctx, request?.agent);
    const questions = Array.isArray(request.questions) ? request.questions : [];
    const options = Array.isArray(first.options) ? first.options : [];
    // Tapping the notification body already opens DSH, so the three ntfy action
    // slots can all carry options: up to 3 for a single-select question.
    const canAnswer = !first.multiSelect && questions.length === 1 && options.length > 0 && options.length <= MAX_ACTIONS;
    let entry = null;
    try {
      entry = pending.begin('question', cfg.reply.ttlSec);
      entry.question = first;
      const tokens = [];
      if (canAnswer) {
        for (const [index, option] of options.entries()) {
          const issued = issueToken(store.secret, 'question', String(index), cfg.reply.ttlSec);
          pending.register(entry, issued.nonce);
          tokens.push({ token: issued.token, label: clampText(option.label, 40) });
        }
      }

      void deliver('question', cfg, {
        title:
          questions.length > 1
            ? `等你回答（${questions.length} 个问题）：${clampText(first.header || first.question, 50)}`
            : `等你回答：${clampText(first.header || first.question, 60)}`,
        message: [`会话：${title}`, '', clampText(first.question, 400), first.detail ? clampText(first.detail, 300) : '', canAnswer ? '' : questions.length > 1 ? `共 ${questions.length} 个问题，需要打开 DSH 逐个作答。` : '可点通知打开会话作答。']
          .filter((line) => line !== '')
          .join('\n'),
        priority: cfg.priority.question,
        tags: cfg.tags.question,
        click: clickTarget(ctx, cfg, request?.agent?.id, title),
        actions: (() => {
          const optionActions = replyActions(cfg, tokens);
          return optionActions.length >= MAX_ACTIONS
            ? optionActions
            : [...optionActions, ...openActions(ctx, cfg, request?.agent?.id, title)];
        })(),
      });

      // Give the notification a head start: if the phone answers inside this
      // window the web prompt is never shown, so no stale card is left behind.
      const graceMs = Math.max(0, Number(cfg.reply.webPromptDelaySec ?? 0) * 1000);
      const early = await Promise.race([
        entry.promise.then((value) => (value ? { source: 'phone', value } : null)),
        new Promise((resolve) => setTimeout(() => resolve({ source: 'grace' }), graceMs)),
      ]);
      if (early && early.source === 'phone') {
        console.log(`[${PLUGIN}] grace hit: answered on the phone, web prompt never shown`);
        return early.value;
      }
      console.log(`[${PLUGIN}] grace expired: showing the web prompt too`);
      startNative();
      const winner = await Promise.race([
        native,
        entry.promise.then((value) => (value ? { source: 'phone', value } : null)),
      ]);
      if (winner && winner.source === 'phone') {
        nativeRaw.catch(() => {});
        return winner.value;
      }
      if (winner && winner.source === 'ui') {
        pending.cancel(entry);
        return winner.value;
      }
      if (winner && winner.source === 'ui-error') {
        pending.cancel(entry);
        throw winner.error;
      }
      const settled = await native;
      pending.cancel(entry);
      if (settled.source === 'ui') return settled.value;
      throw settled.error ?? new Error('question answerer failed');
    } catch (error) {
      pending.cancel(entry);
      const settled = await (native ?? startNative()).catch((inner) => ({ source: 'ui-error', error: inner }));
      if (settled.source === 'ui') return settled.value;
      throw settled.error ?? error;
    }
  }

  // -- passive events -------------------------------------------------------

  function onStatus(payload) {
    try {
      const agent = payload?.agent;
      const sessionId = agent?.id || '';
      const status = payload?.status;
      const previous = previousStatus.get(sessionId);
      previousStatus.set(sessionId, status);
      if (status !== 'idle' || previous !== 'running') return;
      const cfg = store.current;
      if (!shouldSend(cfg, 'turnEnd', cfg.priority.turnEnd, sessionId)) return;
      const title = sessionTitleOf(ctx, agent);
      const preview = cfg.includePreview ? clampText(lastAssistantText(agent?.session), PREVIEW_CHARS) : '';
      void deliver('turnEnd', cfg, {
        title: `跑完了：${clampText(title, 80)}`,
        message: preview ? `会话：${title}\n\n${preview}` : `会话：${title}`,
        priority: cfg.priority.turnEnd,
        tags: cfg.tags.turnEnd,
        click: clickTarget(ctx, cfg, sessionId, title),
        actions: openActions(ctx, cfg, sessionId, title),
      });
    } catch (error) {
      console.warn(`[${PLUGIN}] turnEnd handler: ${describeError(error)}`);
    }
  }

  function onAgentError(payload) {
    try {
      const cfg = store.current;
      const sessionId = payload?.agent?.id || '';
      if (!shouldSend(cfg, 'error', cfg.priority.error, sessionId)) return;
      const title = sessionTitleOf(ctx, payload?.agent);
      void deliver('error', cfg, {
        title: `出错：${clampText(title, 80)}`,
        message: [`会话：${title}`, `轮次 ${payload?.turn ?? '?'} / 步骤 ${payload?.step ?? '?'}`, clampText(describeError(payload?.error), 300)].join('\n'),
        priority: cfg.priority.error,
        tags: cfg.tags.error,
        click: clickTarget(ctx, cfg, sessionId, title),
        actions: openActions(ctx, cfg, sessionId, title),
      });
    } catch (error) {
      console.warn(`[${PLUGIN}] error handler: ${describeError(error)}`);
    }
  }

  function onSubagentEnd(info) {
    try {
      const cfg = store.current;
      if (!shouldSend(cfg, 'subagent', cfg.priority.subagent, String(info?.id ?? ''))) return;
      const output = Array.isArray(info?.lastAssistantMessage)
        ? clampText(
            info.lastAssistantMessage
              .filter((block) => block?.type === 'text')
              .map((block) => block.text)
              .join(' '),
            PREVIEW_CHARS,
          )
        : '';
      void deliver('subagent', cfg, {
        title: `子任务结束：${clampText(info?.provider || 'subagent', 40)}`,
        message: [`状态：${info?.stopReason || 'unknown'}`, output].filter(Boolean).join('\n'),
        priority: cfg.priority.subagent,
        tags: cfg.tags.subagent,
        click: clickTarget(ctx, cfg, '', ''),
        actions: openActions(ctx, cfg, '', ''),
      });
    } catch (error) {
      console.warn(`[${PLUGIN}] subagent handler: ${describeError(error)}`);
    }
  }

  function onWorkflowEnd(info, result) {
    try {
      const cfg = store.current;
      if (!shouldSend(cfg, 'workflow', cfg.priority.workflow, String(info?.id ?? ''))) return;
      const label = info?.meta?.name || result?.id || 'workflow';
      void deliver('workflow', cfg, {
        title: `工作流结束：${clampText(String(label), 60)}`,
        message: `状态：${result?.stopReason || result?.status || 'settled'}`,
        priority: cfg.priority.workflow,
        tags: cfg.tags.workflow,
        click: clickTarget(ctx, cfg, '', ''),
        actions: openActions(ctx, cfg, '', ''),
      });
    } catch (error) {
      console.warn(`[${PLUGIN}] workflow handler: ${describeError(error)}`);
    }
  }

  // -- public reply route ---------------------------------------------------

  function replyPage(ok, message) {
    const tone = ok ? '#16a34a' : '#dc2626';
    const mark = ok ? '✓' : '!';
    return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>DSH · ntfy 推送</title><style>
:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f8fb;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2937}
@media(prefers-color-scheme:dark){body{background:#0f172a;color:#e5e7eb}}
main{max-width:22rem;padding:2rem 1.5rem;text-align:center}
b{display:inline-flex;width:3.4rem;height:3.4rem;align-items:center;justify-content:center;border-radius:50%;background:${tone};color:#fff;font-size:1.9rem;line-height:1}
p{margin:1rem 0 .35rem;font-size:1.02rem}
small{opacity:.65}</style></head><body><main><b>${mark}</b><p>${message}</p><small>可以关掉这个页面了</small></main></body></html>`;
  }

  /**
   * Same-origin hop for notification taps. Cross-site browsers refuse to carry
   * DSH's SameSite=Strict login cookie across the server's 303, so the tap lands
   * here first (no cookie needed) and a same-site navigation performs the login.
   * Only same-origin targets are accepted: this is not an open redirect.
   */
  function handleOpenHop(req, res, url) {
    const raw = url.searchParams.get('u') || '';
    const base = publicBase(ctx);
    let target = null;
    try {
      const parsed = new URL(raw);
      const origin = base ? new URL(base).origin : null;
      if (origin && parsed.origin === origin && (parsed.protocol === 'https:' || parsed.protocol === 'http:')) target = parsed.href;
    } catch {
      /* invalid target */
    }
    const send = (status, type, body) => {
      const headers = { 'content-type': type, 'cache-control': 'no-store' };
      if (typeof res.writeHead === 'function') {
        res.writeHead(status, headers);
        res.end(body);
      } else {
        res.status = status;
        res.headers = headers;
        res.body = body;
      }
    };
    if (!target) {
      send(400, 'text/plain; charset=utf-8', 'bad target\n');
      return undefined;
    }
    const ua = String(req.headers?.['user-agent'] || '').slice(0, 80);
    console.log(`[${PLUGIN}] open hop${ua ? ` ua="${ua}"` : ''}`);
    const href = target.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    const html = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><title>正在进入 DSH…</title><style>
:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f6f8fb;font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2937}
@media(prefers-color-scheme:dark){body{background:#0f172a;color:#e5e7eb}}
main{text-align:center;padding:2rem}a{color:#2563eb}</style></head><body><main><p>正在进入 DSH…</p><p><a href="${href}">没反应？点这里</a></p></main>
<script>location.replace(${JSON.stringify(target).replace(/</g, '\\u003c')});</script></body></html>`;
    send(200, 'text/html; charset=utf-8', html);
    return undefined;
  }

  /** Raw node:http handler (the web server hands us req/res, not a Fetch request). */
  async function handleReply(req, res) {
    await store.ensure();
    const url = new URL(req.url || '/', 'http://localhost');
    const token = url.searchParams.get('t') || '';
    const wantsJson =
      url.searchParams.get('format') === 'json' || String(req.headers?.accept || '').includes('application/json');
    const reply = (status, payload) => {
      const body = wantsJson ? JSON.stringify(payload) : replyPage(status < 400, payload.message || payload.error || '');
      const headers = {
        'content-type': wantsJson ? 'application/json; charset=utf-8' : 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      };
      if (typeof res.writeHead === 'function') {
        res.writeHead(status, headers);
        res.end(body);
      } else {
        // Test harness path: a plain object with status/body.
        res.status = status;
        res.body = body;
      }
      return undefined;
    };

    if (url.pathname === `${REPLY_PREFIX}/open`) return handleOpenHop(req, res, url);
    if (url.pathname === `${REPLY_PREFIX}/health`) {
      // Always JSON: this route is the deployment probe (curl, monitors).
      const cfg = store.current;
      res.writeHead?.(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end?.(
        JSON.stringify({
          ok: true,
          plugin: PLUGIN,
          configured: Boolean(cfg.serverUrl && cfg.topic),
          replyReady: Boolean(cfg.reply.enabled && publicBase(ctx)),
        }),
      );
      return undefined;
    }
    if (!token) return reply(400, { ok: false, error: 'missing-token', message: '缺少回执令牌。' });

    const verified = verifyToken(store.secret, token);
    if (verified.error === 'bad-signature' || verified.error === 'bad-token') {
      return reply(403, { ok: false, error: 'bad-signature', message: '令牌无效。' });
    }
    if (verified.error === 'expired') {
      return reply(410, { ok: false, error: 'expired', message: '这个通知已经过期，请在 DSH 里处理。' });
    }

    const payload = verified.payload;
    const ua = String(req.headers?.['user-agent'] || '').slice(0, 60);
    const consumed = pending.consume(payload.n);
    if (consumed.error) {
      // Idempotent by design: a second tap (or an app retry) must not look like
      // a failure, and the notification may already be cleared on the phone.
      console.log(`[${PLUGIN}] reply already settled ua="${ua}"`);
      return reply(200, { ok: true, already: true, error: 'used', message: '已经处理过了，或在 DSH 里已经答复。' });
    }
    const entry = consumed.entry;

    if (payload.k === 'approval' && entry.kind === 'approval') {
      const outcome = payload.v === 'allowed-once' ? 'allowed-once' : payload.v === 'rejected' ? 'rejected' : null;
      if (!outcome) return reply(400, { ok: false, error: 'bad-value', message: '无法识别的决定。' });
      entry.resolve(outcome);
      console.log(`[${PLUGIN}] reply approval=${outcome} ua="${ua}"`);
      return reply(200, { ok: true, kind: 'approval', outcome, message: outcome === 'allowed-once' ? '已批准，DSH 会继续执行。' : '已拒绝。' });
    }

    if (payload.k === 'question' && entry.kind === 'question') {
      const question = entry.question;
      const index = Number.parseInt(String(payload.v), 10);
      const option = question?.options?.[index];
      if (!option) return reply(400, { ok: false, error: 'bad-value', message: '无法识别的选项。' });
      entry.resolve({ answers: [{ id: question.id, selected: [option.label] }] });
      console.log(`[${PLUGIN}] reply question="${clampText(option.label, 30)}" ua="${ua}"`);
      return reply(200, { ok: true, kind: 'question', selected: option.label, message: `已选择：${clampText(option.label, 40)}` });
    }

    return reply(400, { ok: false, error: 'bad-kind', message: '未知的回执类型。' });
  }

  // -- authenticated API ----------------------------------------------------

  async function snapshot() {
    const cfg = store.current;
    const [token, password] = await Promise.all([describeSecret(ctx, cfg.tokenRef), describeSecret(ctx, cfg.passwordRef)]);
    return {
      ok: true,
      configured: Boolean(cfg.serverUrl && cfg.topic),
      settings: cfg,
      credential: {
        token: token.configured,
        password: password.configured,
        source: token.configured ? token.source : password.configured ? password.source : 'none',
      },
      lastDelivery: state.lastDelivery,
      replyReady: Boolean(cfg.reply.enabled && publicBase(ctx)),
    };
  }

  async function handleApi(request) {
    await store.ensure();
    const method = request.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD') return json(await snapshot());
    if (method !== 'POST') return json({ ok: false, error: 'method-not-allowed' }, 405);

    const length = Number(request.headers.get('content-length') ?? 0);
    if (Number.isFinite(length) && length > MAX_POST_BYTES) return json({ ok: false, error: 'body-too-large' }, 413);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: 'invalid-json' }, 400);
    }
    const action = asString(body?.action);
    const credentials = ctx.get('credentials');
    const writeSecret = async (ref, value) => {
      if (!credentials || typeof credentials.set !== 'function') return 'credential-store-unavailable';
      try {
        await credentials.set(ref, value);
        return null;
      } catch (error) {
        return `credential-write-failed: ${describeError(error)}`;
      }
    };

    if (action === 'save') {
      const next = await store.save(body?.settings ?? {});
      if (typeof body?.token === 'string' && body.token.trim()) {
        const failure = await writeSecret(next.tokenRef, body.token.trim());
        if (failure) return json({ ok: false, error: failure }, 500);
      }
      if (typeof body?.password === 'string' && body.password.trim()) {
        const failure = await writeSecret(next.passwordRef, body.password.trim());
        if (failure) return json({ ok: false, error: failure }, 500);
      }
      return json(await snapshot());
    }

    if (action === 'test') {
      const cfg = store.current;
      const receipt = await publish(ctx, cfg, {
        title: 'dsh-ntfy-push 测试',
        message: [
          '这是一条测试推送。',
          `服务器：${cfg.serverUrl}`,
          `Topic：${cfg.topic}`,
          `回执按钮：${cfg.reply.enabled ? '开启' : '关闭'}`,
        ].join('\n'),
        priority: 3,
        tags: ['white_check_mark'],
        click: clickTarget(ctx, cfg, '', ''),
        actions: [],
      });
      record('test', receipt);
      return json({ ...(await snapshot()), ok: receipt.ok, httpStatus: receipt.httpStatus, detail: receipt.detail || receipt.error });
    }

    if (action === 'clearSecret') {
      const which = body?.which === 'password' ? 'password' : 'token';
      const ref = which === 'password' ? store.current.passwordRef : store.current.tokenRef;
      if (!credentials || typeof credentials.unset !== 'function') return json({ ok: false, error: 'credential-store-unavailable' }, 503);
      try {
        await credentials.unset(ref);
      } catch (error) {
        return json({ ok: false, error: describeError(error) }, 500);
      }
      return json(await snapshot());
    }

    return json({ ok: false, error: 'unknown-action' }, 400);
  }

  // -- wiring ---------------------------------------------------------------

  const connection = ctx.get('connection');
  if (connection?.fetch && typeof connection.fetch.register === 'function') {
    ctx.effect(
      () => connection.fetch.register({ path: API_ROUTE, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: handleApi }),
      `${PLUGIN}: settings route`,
    );
  } else {
    console.warn(`[${PLUGIN}] connection service unavailable; settings API is off`);
  }

  const webServer = ctx.get('webServer');
  if (webServer && typeof webServer.register === 'function') {
    try {
      ctx.effect(
        () => webServer.register({ kind: 'prefix', path: REPLY_PREFIX, handler: handleReply }),
        `${PLUGIN}: reply route`,
      );
    } catch (error) {
      console.warn(`[${PLUGIN}] reply route unavailable: ${describeError(error)}`);
    }
    if (typeof webServer.tapIndex === 'function') {
      try {
        const boot = JSON.stringify({ route: API_ROUTE, replyPath: REPLY_ROUTE }).replace(/<\/script/gi, '<\\/script');
        ctx.effect(
          () =>
            webServer.tapIndex((html) => {
              const script = `<script>window.${BOOT_GLOBAL}=${boot};</script>`;
              const text = String(html);
              return text.includes('</head>') ? text.replace('</head>', `${script}</head>`) : `${script}${text}`;
            }),
          `${PLUGIN}: boot config`,
        );
      } catch {
        /* the Client half keeps its built-in defaults */
      }
    }
  }

  // The browser bridge (`dsh-api-remotes`) registers the same two waterfalls at
  // boot and claims every request by waiting for the human. Cordis runs
  // waterfall listeners in registration order, so a plain `ctx.on` here would
  // never be called. `prepend` puts us first: we push the notification, hand
  // the request to the native answerer with `next()`, and race the two.
  ctx.on('approval/request', onApproval, { prepend: true, global: true });
  ctx.on('user-questions/request', onQuestion, { prepend: true, global: true });
  ctx.on('agent/status', onStatus);
  ctx.on('agent/error', onAgentError);
  ctx.on('subagent/end', onSubagentEnd);
  ctx.on('workflow/end', onWorkflowEnd);

  store.ensure();
  console.log(`[${PLUGIN}] ready (server ${store.current.serverUrl}, topic ${store.current.topic || '(unset)'})`);

  return () => {
    pending.shutdown();
  };
}