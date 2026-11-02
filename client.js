// Client half of `dsh-ntfy-push`.
//
// Registers one page in the settings panel (`settings.section`, nav id
// `dsh-ntfy-push`, order 30). The page edits the runtime settings the Host half
// merges over the patch config: server URL, topic, authentication, the six
// event switches, the notification click template, reply buttons and their
// token lifetime, quiet hours and pacing.
//
// Data comes from the Host's authenticated API (`GET`/`POST`
// `/api/dsh-ntfy-push`, see SPEC.md §2) through `fetch` with
// `credentials: 'same-origin'`. The route and the public reply path reach this
// half through `window.__DSH_NTFY_PUSH_BOOT__`; the built-in defaults keep the
// page working when that injection is unavailable.
//
// Secrets are write-only from the browser's point of view: token and password
// inputs start empty, their placeholder reports "configured", an empty input
// means "keep the stored value", and the API only ever answers with booleans.
window.__ModuleLoader__.load({
  id: 'dsh-ntfy-push',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-ntfy-push';
    const BOOT = (typeof window !== 'undefined' && window.__DSH_NTFY_PUSH_BOOT__) || {};
    const ROUTE =
      typeof BOOT.route === 'string' && BOOT.route.trim() !== ''
        ? BOOT.route.trim()
        : '/api/dsh-ntfy-push';
    const REPLY_PATH =
      typeof BOOT.replyPath === 'string' && BOOT.replyPath.trim() !== ''
        ? BOOT.replyPath.trim()
        : '/dsh-ntfy-push/reply';
    const SLOT = 'settings.section';
    const SLOT_ID = 'dsh-ntfy-push';
    const SLOT_ORDER = 30;

    const EVENT_KEYS = ['approval', 'question', 'turnEnd', 'error', 'subagent', 'workflow'];
    const AUTH_MODES = ['none', 'token', 'basic'];
    const EVENT_LABEL = {
      approval: 'evApproval',
      question: 'evQuestion',
      turnEnd: 'evTurnEnd',
      error: 'evError',
      subagent: 'evSubagent',
      workflow: 'evWorkflow',
    };
    const TTL_MIN = 30;
    const TTL_MAX = 86400;
    const TTL_DEFAULT = 600;
    const INTERVAL_MIN = 0;
    const INTERVAL_MAX = 3600;
    const INTERVAL_DEFAULT = 20;

    // ------------------------------------------------------------------
    // normalization
    // ------------------------------------------------------------------
    function text(value, fallback) {
      return typeof value === 'string' ? value : fallback;
    }

    function flag(value, fallback) {
      return typeof value === 'boolean' ? value : fallback;
    }

    function number(value, fallback) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : fallback;
    }

    function timeText(value, fallback) {
      return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
    }

    function clampNumber(value, min, max, fallback) {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) return fallback;
      return Math.min(max, Math.max(min, Math.round(parsed)));
    }

    function absoluteUrl(path) {
      if (typeof path !== 'string' || path.trim() === '') return '';
      if (/^https?:\/\//i.test(path)) return path;
      const origin =
        typeof window !== 'undefined' && window.location && typeof window.location.origin === 'string'
          ? window.location.origin
          : '';
      if (origin === '') return path;
      const trimmed = origin.replace(/\/+$/, '');
      return trimmed + (path.charAt(0) === '/' ? path : '/' + path);
    }

    function messageOf(error) {
      if (error && typeof error.message === 'string' && error.message !== '') return error.message;
      return String(error);
    }

    function normalizeSettings(raw) {
      const source = raw && typeof raw === 'object' ? raw : {};
      const reply = source.reply && typeof source.reply === 'object' ? source.reply : {};
      const quiet = source.quietHours && typeof source.quietHours === 'object' ? source.quietHours : {};
      const declaredEvents = Array.isArray(source.events) ? source.events : null;
      const events =
        declaredEvents === null
          ? EVENT_KEYS.slice()
          : EVENT_KEYS.filter((key) => declaredEvents.indexOf(key) !== -1);
      const authMode = text(source.authMode, 'token');
      return {
        serverUrl: text(source.serverUrl, ''),
        topic: text(source.topic, ''),
        authMode: AUTH_MODES.indexOf(authMode) === -1 ? 'token' : authMode,
        username: text(source.username, ''),
        events,
        clickTemplate: text(source.clickTemplate, ''),
        clickMode: ['token', 'plain', 'none'].indexOf(text(source.clickMode, 'token')) === -1 ? 'token' : text(source.clickMode, 'token'),
        reply: {
          enabled: flag(reply.enabled, true),
          ttlSec: number(reply.ttlSec, TTL_DEFAULT),
          webPromptDelaySec: clampNumber(reply.webPromptDelaySec, 0, 60, 0),
        },
        quietHours: {
          enabled: flag(quiet.enabled, false),
          from: timeText(quiet.from, '23:00'),
          to: timeText(quiet.to, '08:00'),
          urgentBypass: flag(quiet.urgentBypass, true),
        },
        minIntervalSec: number(source.minIntervalSec, INTERVAL_DEFAULT),
        includePreview: flag(source.includePreview, true),
      };
    }

    function statusFrom(data) {
      const raw = data && typeof data === 'object' ? data : {};
      const settings = normalizeSettings(raw.settings);
      const credential = raw.credential && typeof raw.credential === 'object' ? raw.credential : {};
      const rawDelivery = raw.lastDelivery && typeof raw.lastDelivery === 'object' ? raw.lastDelivery : null;
      const delivery = {
        at:
          rawDelivery !== null && typeof rawDelivery.at === 'number' && Number.isFinite(rawDelivery.at)
            ? rawDelivery.at
            : null,
        ok: rawDelivery !== null && rawDelivery.ok === true,
        event: rawDelivery !== null ? text(rawDelivery.event, '') : '',
        detail: rawDelivery !== null ? text(rawDelivery.detail, '') : '',
      };
      const configured =
        typeof raw.configured === 'boolean'
          ? raw.configured
          : settings.serverUrl.trim() !== '' && settings.topic.trim() !== '';
      const replyReady =
        typeof raw.replyReady === 'boolean'
          ? raw.replyReady
          : settings.reply.enabled && absoluteUrl(REPLY_PATH) !== '';
      return {
        configured,
        settings,
        credential: {
          token: credential.token === true,
          password: credential.password === true,
          source: text(credential.source, 'none'),
        },
        lastDelivery: delivery,
        replyReady,
      };
    }

    // ------------------------------------------------------------------
    // transport
    // ------------------------------------------------------------------
    async function requestJson(method, body) {
      const headers = { accept: 'application/json' };
      const options = { method, credentials: 'same-origin', headers };
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
        options.body = JSON.stringify(body);
      }
      const response = await fetch(ROUTE, options);
      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }
      if (!response.ok) {
        const detail =
          data && typeof data.error === 'string' && data.error !== ''
            ? data.error
            : data && typeof data.detail === 'string' && data.detail !== ''
              ? data.detail
              : '';
        throw new Error(detail !== '' ? detail : 'HTTP ' + String(response.status));
      }
      if (data === null || typeof data !== 'object') throw new Error('invalid response');
      return data;
    }

    // ------------------------------------------------------------------
    // formatting
    // ------------------------------------------------------------------
    function formatStamp(timestamp, loc) {
      if (!Number.isFinite(timestamp)) return '';
      try {
        const date = new Date(timestamp);
        if (Number.isNaN(date.getTime())) return '';
        const now = new Date();
        const sameDay =
          date.getFullYear() === now.getFullYear() &&
          date.getMonth() === now.getMonth() &&
          date.getDate() === now.getDate();
        const options = sameDay
          ? { hour: '2-digit', minute: '2-digit', hour12: false }
          : { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
        return new Intl.DateTimeFormat(loc === 'zh' ? 'zh-CN' : 'en-US', options).format(date);
      } catch {
        return '';
      }
    }

    function deliveryText(delivery, t, loc) {
      if (!delivery || !Number.isFinite(delivery.at)) return t('neverDelivered');
      const parts = [formatStamp(delivery.at, loc), delivery.ok ? t('deliveryOk') : t('deliveryFail')];
      if (delivery.event !== '') {
        parts.push(
          delivery.event === 'test'
            ? t('evTest')
            : Object.prototype.hasOwnProperty.call(EVENT_LABEL, delivery.event)
              ? t(EVENT_LABEL[delivery.event])
              : delivery.event,
        );
      }
      if (delivery.detail !== '') parts.push(delivery.detail);
      return parts.filter((part) => part !== '').join(' · ');
    }

    // ------------------------------------------------------------------
    // dictionaries (zh/en fallbacks, same shape as the Qianfan plugin)
    // ------------------------------------------------------------------
    const DICTS = {
      zh: {
        nav: '通知推送',
        title: 'ntfy 消息推送',
        desc: '把审批等待、提问、回合结束、出错、子任务与工作流结束推到你的 ntfy 服务器；手机通知里可直接批准或作答。',
        loading: '正在读取配置…',
        refreshing: '刷新中…',
        loadFailed: '读取配置失败',
        retry: '重试',
        refresh: '刷新',
        unsaved: '有未保存的改动',
        save: '保存',
        saving: '保存中…',
        saved: '已保存',
        saveFailed: '保存失败',
        test: '发送测试',
        testing: '发送中…',
        testNeedsSaved: '「发送测试」使用已保存的配置；改动请先保存。',
        testSent: '测试通知已发送',
        testFailed: '测试通知发送失败',
        clearToken: '清除 Token',
        clearPassword: '清除密码',
        confirmClearToken: '确认清除已保存的 Token？',
        confirmClearPassword: '确认清除已保存的密码？',
        confirm: '确认清除',
        cancel: '取消',
        cleared: '已清除',
        clearing: '清除中…',
        clearFailed: '清除失败',
        status: '状态',
        configured: '已配置',
        notConfigured: '未配置',
        tokenLabel: 'Token',
        passwordLabel: '密码',
        credentialSet: '已配置',
        credentialUnset: '未设置',
        replyReady: '回执可用',
        replyNotReady: '回执不可用',
        replyNotReadyHint: '回执暂不可用：回执开关关闭，或 Host 无法算出公开回执基址（需要可公网访问的 DSH 地址）。',
        lastDelivery: '最近投递',
        neverDelivered: '还没有投递记录',
        deliveryOk: '成功',
        deliveryFail: '失败',
        serverSection: '服务器与认证',
        serverUrl: '服务器地址',
        serverUrlHint: 'ntfy 根地址，例如 https://ntfy.sh 或 http://192.168.1.10:2586；允许自建/私网地址。',
        topic: 'Topic',
        topicHint: '手机端订阅的 topic 名称；留空则不推送。',
        authMode: '认证方式',
        authNone: '无认证',
        authToken: 'Token（Bearer）',
        authBasic: '用户名 + 密码（Basic）',
        authNoneHint: '不发送 Authorization 头。',
        username: '用户名',
        usernameHint: 'basic 认证用户名，非机密，保存在配置里。',
        token: 'Token',
        tokenHint: '留空 = 保持已保存的 Token；Token 只写入 DSH 凭据库，页面永不回显。',
        configuredPlaceholder: '已配置（留空保持不变）',
        password: '密码',
        passwordHint: '留空 = 保持已保存的密码；密码只写入 DSH 凭据库，页面永不回显。',
        eventsSection: '推送事件',
        eventsHint: '只推送勾选的事件类型。',
        eventsNone: '未勾选任何事件：不会推送。',
        evApproval: '审批等待',
        evQuestion: '提问等待',
        evTurnEnd: '回合结束',
        evError: '出错停止',
        evSubagent: '子任务结束',
        evWorkflow: '工作流结束',
        evTest: '测试',
        clickSection: '点击与回执',
        clickMode: '点击通知打开',
        clickModeToken: '自动登录（推荐）',
        clickModePlain: '仅打开地址',
        clickModeNone: '不跳转',
        clickModeHint:
          '自动登录会把本次进程的登录令牌拼进 URL，手机点开直接进入 DSH（令牌随重启轮换，也会出现在 ntfy 消息里）；仅打开地址要求手机浏览器已登录过。',
        clickTemplate: '点击地址模板',
        clickTemplateHint: '填写后覆盖上面的点击方式；支持 {sessionId} 与 {title} 占位。',
        replyEnabled: '通知里带回执按钮',
        replyEnabledHint: '审批带「批准 / 拒绝」，提问在单选且选项 ≤ 2 时每个选项一个按钮；ntfy 最多 3 个动作。',
        replyTtl: '回执有效期（秒）',
        webPromptDelay: '先等手机（秒）',
        webPromptDelayHint:
          '0 = 网页立刻弹（手机作答后卡片自动消失，推荐）；大于 0 = 先等手机这么多秒再弹，手机在此窗口内作答则网页全程不弹。',
        replyTtlHint: '一次性回执令牌的有效时间，30–86400 秒。',
        replyBase: '回执基址',
        replyBaseHint: '手机按钮命中这个公开地址；令牌一次性且带签名，不含 DSH 登录凭据。',
        copy: '复制',
        copied: '已复制',
        quietSection: '免打扰与节奏',
        quietEnabled: '启用免打扰',
        quietFrom: '开始时间',
        quietTo: '结束时间',
        quietRange: '免打扰时段',
        quietBypass: '紧急事件穿透免打扰',
        quietBypassHint: 'priority 5（审批、出错）在免打扰期间照常推送。',
        minInterval: '同类事件最小间隔（秒）',
        minIntervalHint: '同一会话、同一类事件的最小推送间隔；0 = 不限制。',
        preview: '回合结束通知带正文预览',
        previewHint: '附上最后一段助手正文，最多 160 字。',
        errInvalidUrl: '服务器地址需以 http:// 或 https:// 开头。',
        errNotConfigured: '还没有配置服务器地址或 topic，无法发送测试。',
        errUnknown: '未知错误',
      },
      en: {
        nav: 'Push notifications',
        title: 'ntfy push notifications',
        desc: 'Push approval waits, questions, turn ends, errors, subagent and workflow completions to your ntfy server — then approve or answer from the phone notification.',
        loading: 'Loading settings…',
        refreshing: 'Refreshing…',
        loadFailed: 'Could not load settings',
        retry: 'Retry',
        refresh: 'Refresh',
        unsaved: 'Unsaved changes',
        save: 'Save',
        saving: 'Saving…',
        saved: 'Saved',
        saveFailed: 'Save failed',
        test: 'Send test',
        testing: 'Sending…',
        testNeedsSaved: '"Send test" uses the saved configuration; save changes first.',
        testSent: 'Test notification sent',
        testFailed: 'Test notification failed',
        clearToken: 'Clear token',
        clearPassword: 'Clear password',
        confirmClearToken: 'Clear the saved token?',
        confirmClearPassword: 'Clear the saved password?',
        confirm: 'Clear',
        cancel: 'Cancel',
        cleared: 'Cleared',
        clearing: 'Clearing…',
        clearFailed: 'Could not clear the credential',
        status: 'Status',
        configured: 'Configured',
        notConfigured: 'Not configured',
        tokenLabel: 'Token',
        passwordLabel: 'Password',
        credentialSet: 'set',
        credentialUnset: 'not set',
        replyReady: 'Replies ready',
        replyNotReady: 'Replies unavailable',
        replyNotReadyHint:
          'Replies are unavailable right now: reply buttons are off, or the Host cannot resolve a public reply base URL (a publicly reachable DSH address is required).',
        lastDelivery: 'Last delivery',
        neverDelivered: 'No deliveries yet',
        deliveryOk: 'ok',
        deliveryFail: 'failed',
        serverSection: 'Server and authentication',
        serverUrl: 'Server URL',
        serverUrlHint:
          'ntfy root URL, e.g. https://ntfy.sh or http://192.168.1.10:2586. Self-hosted and private addresses are allowed.',
        topic: 'Topic',
        topicHint: 'Topic your phone subscribes to; leave empty to disable pushing.',
        authMode: 'Authentication',
        authNone: 'None',
        authToken: 'Token (Bearer)',
        authBasic: 'Username + password (Basic)',
        authNoneHint: 'No Authorization header is sent.',
        username: 'Username',
        usernameHint: 'Basic-auth username. Not a secret, stored in the config.',
        token: 'Token',
        tokenHint: 'Leave empty to keep the saved token. Tokens go to the DSH credential store and are never echoed here.',
        configuredPlaceholder: 'Configured (leave empty to keep)',
        password: 'Password',
        passwordHint:
          'Leave empty to keep the saved password. Passwords go to the DSH credential store and are never echoed here.',
        eventsSection: 'Events to push',
        eventsHint: 'Only the checked event kinds are pushed.',
        eventsNone: 'No events selected — nothing will be pushed.',
        evApproval: 'Approval wait',
        evQuestion: 'Question wait',
        evTurnEnd: 'Turn finished',
        evError: 'Error',
        evSubagent: 'Subagent finished',
        evWorkflow: 'Workflow finished',
        evTest: 'Test',
        clickSection: 'Click target and replies',
        clickMode: 'Open on tap',
        clickModeToken: 'Auto sign-in (recommended)',
        clickModePlain: 'Plain address',
        clickModeNone: 'No navigation',
        clickModeHint:
          'Auto sign-in appends this process\'s login token to the URL, so a phone opens DSH already signed in (the token rotates on restart and appears in the ntfy message); plain address needs the phone browser to have a live DSH cookie.',
        clickTemplate: 'Click URL template',
        clickTemplateHint:
          'URL opened by tapping the notification; empty uses the DSH address. Supports {sessionId} and {title}.',
        replyEnabled: 'Reply buttons in the notification',
        replyEnabledHint:
          'Approvals get approve / reject; single-choice questions with ≤ 2 options get one button per option. ntfy allows at most 3 actions.',
        replyTtl: 'Reply token lifetime (seconds)',
        webPromptDelay: 'Wait for phone (seconds)',
        webPromptDelayHint:
          '0 = show the web prompt immediately (it disappears by itself once the phone answers, recommended); above 0 = wait this long for the phone first, and the web card never appears if the phone answers inside this window.',
        replyTtlHint: 'How long a one-time reply token stays valid, 30–86400 seconds.',
        replyBase: 'Reply base URL',
        replyBaseHint: 'Phone buttons hit this public address; tokens are one-time, signed, and carry no DSH login credentials.',
        copy: 'Copy',
        copied: 'Copied',
        quietSection: 'Quiet hours and pacing',
        quietEnabled: 'Enable quiet hours',
        quietFrom: 'From',
        quietTo: 'To',
        quietRange: 'Quiet hours',
        quietBypass: 'Urgent events bypass quiet hours',
        quietBypassHint: 'Priority 5 events (approvals, errors) are still pushed during quiet hours.',
        minInterval: 'Minimum interval per event kind (seconds)',
        minIntervalHint: 'Minimum gap between pushes of the same kind in one session; 0 = no limit.',
        preview: 'Include a text preview on turn-end notifications',
        previewHint: 'Appends the tail of the last assistant message, up to 160 characters.',
        errInvalidUrl: 'The server URL must start with http:// or https://.',
        errNotConfigured: 'Server URL or topic is not configured, so a test cannot be sent.',
        errUnknown: 'Unknown error',
      },
    };

    // ------------------------------------------------------------------
    // styles (theme tokens only; light and dark both readable)
    // ------------------------------------------------------------------
    const CSS = [
      '.ntfy-section{box-sizing:border-box;display:flex;flex-direction:column;gap:16px;padding:8px 0 4px;min-width:0;max-width:100%;color:var(--dsw-alias-label-primary);font-size:13px;line-height:22px}',
      '.ntfy-head{display:flex;align-items:flex-start;gap:12px;min-width:0}',
      '.ntfy-head-main{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}',
      '.ntfy-title{margin:0;font-size:16px;line-height:24px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.ntfy-desc{margin:0;font-size:12.5px;line-height:19px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
      '.ntfy-head-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex:none;flex-wrap:wrap}',
      '.ntfy-card{box-sizing:border-box;display:flex;flex-direction:column;gap:12px;min-width:0;padding:14px 16px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-settings-card-fill)}',
      '.ntfy-card-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}',
      '.ntfy-card-title{margin:0;font-size:13.5px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.ntfy-badges{display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-left:auto}',
      '.ntfy-chip{display:inline-flex;align-items:center;gap:4px;flex:none;padding:1px 8px;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:18px;white-space:nowrap}',
      '.ntfy-chip-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-state-success-primary)}',
      '.ntfy-chip-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.ntfy-kv{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 12px;min-width:0;font-size:12.5px;line-height:20px}',
      '.ntfy-kv-k{color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.ntfy-kv-v{min-width:0;color:var(--dsw-alias-label-primary);overflow-wrap:anywhere;font-variant-numeric:tabular-nums}',
      '.ntfy-note{box-sizing:border-box;display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;padding:9px 12px;border-radius:10px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.ntfy-note-ok{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 13%,transparent);color:var(--dsw-alias-state-success-primary)}',
      '.ntfy-note-warn{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.ntfy-note-bad{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.ntfy-note-text{flex:1;min-width:0;overflow-wrap:anywhere}',
      '.ntfy-field{display:flex;flex-direction:column;gap:5px;min-width:0}',
      '.ntfy-label{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.ntfy-input{box-sizing:border-box;width:100%;max-width:100%;min-width:0;height:34px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;color-scheme:light}',
      'body[data-ds-dark-theme] .ntfy-input{color-scheme:dark}',
      '.ntfy-input::placeholder{color:var(--dsw-alias-label-tertiary);opacity:1}',
      '.ntfy-input:focus-visible{outline:var(--dsw-focus-ring-width,1.5px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}',
      '.ntfy-input:disabled{opacity:.6}',
      '.ntfy-hint{margin:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
      '.ntfy-hint-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.ntfy-inline{display:flex;align-items:center;gap:8px;min-width:0}',
      '.ntfy-inline .ntfy-input{flex:1;min-width:0}',
      '.ntfy-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:12px;min-width:0}',
      '@media (min-width:520px){.ntfy-grid-2{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}}',
      '.ntfy-checks{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:2px 12px;min-width:0}',
      '.ntfy-switch{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.ntfy-check-row{display:flex;align-items:center;gap:8px;min-width:0;min-height:32px}',
      '.ntfy-checkbox{flex:none;width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary)}',
      '.ntfy-checkbox:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.ntfy-check-label{flex:1;min-width:0;font-size:13px;color:var(--dsw-alias-label-primary);cursor:pointer;overflow-wrap:anywhere}',
      '.ntfy-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ntfy-btn{box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:36px;padding:0 14px;border:.5px solid transparent;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font:inherit;font-size:13.5px;font-weight:500;white-space:nowrap;cursor:pointer}',
      '.ntfy-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-active)}',
      '.ntfy-btn:disabled{opacity:.5;cursor:default}',
      '.ntfy-btn:focus-visible{outline:var(--dsw-focus-ring-width,1.5px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}',
      '.ntfy-btn-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.ntfy-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.ntfy-btn-ghost{background:0 0;border-color:var(--dsw-alias-border-l3);color:var(--dsw-alias-label-primary)}',
      '.ntfy-btn-ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.ntfy-btn-danger{background:0 0;border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 45%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.ntfy-btn-danger:hover:not(:disabled){background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 10%,transparent)}',
      '.ntfy-confirm{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 10px;border-radius:10px;background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 8%,transparent);font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.ntfy-confirm-text{flex:1;min-width:0;overflow-wrap:anywhere}',
      '.ntfy-mono{flex:1;min-width:0;padding:6px 8px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;line-height:17px;overflow-wrap:anywhere;user-select:all}',
      '@media (max-width:420px){.ntfy-head{flex-direction:column;align-items:stretch}.ntfy-head-actions{justify-content:flex-start}.ntfy-card{padding:12px}}',
      '@media (max-width:520px){.ntfy-input{font-size:16px}}',
      '@media (prefers-reduced-motion:reduce){.ntfy-btn{transition:none}}',
    ].join('');

    // ------------------------------------------------------------------
    // number field: keeps its own text so clearing the box is possible,
    // while the parent only ever sees a finite number
    // ------------------------------------------------------------------
    function NumberField(props) {
      const { id, value, min, max, step, onChange } = props;
      const [text, setText] = React.useState(value === undefined || value === null ? '' : String(value));

      React.useEffect(() => {
        setText(value === undefined || value === null ? '' : String(value));
      }, [value]);

      return h('input', {
        id,
        type: 'number',
        className: 'ntfy-input',
        value: text,
        min: String(min),
        max: String(max),
        step: String(step),
        inputMode: 'numeric',
        onChange: (event) => {
          const raw = event.target.value;
          setText(raw);
          const parsed = Number(raw);
          if (raw !== '' && Number.isFinite(parsed)) onChange(parsed);
        },
        onBlur: () => {
          if (text.trim() === '' || !Number.isFinite(Number(text))) {
            setText(value === undefined || value === null ? '' : String(value));
          }
        },
      });
    }

    // ------------------------------------------------------------------
    // the settings page
    // ------------------------------------------------------------------
    function NtfySettings(props) {
      const { t, loc } = props;

      const [load, setLoad] = React.useState({ phase: 'loading', error: null });
      const [status, setStatus] = React.useState(null);
      const [form, setForm] = React.useState(null);
      const [tokenInput, setTokenInput] = React.useState('');
      const [passwordInput, setPasswordInput] = React.useState('');
      const [busy, setBusy] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const [confirming, setConfirming] = React.useState(null);
      const [copied, setCopied] = React.useState(false);
      const mounted = React.useRef(true);
      const copyTimer = React.useRef(0);

      React.useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
          if (copyTimer.current) window.clearTimeout(copyTimer.current);
        };
      }, []);

      const showNotice = React.useCallback((kind, message) => {
        if (!mounted.current) return;
        setNotice({ kind, text: message });
      }, []);

      const applyStatus = React.useCallback((data, resetForm) => {
        const next = statusFrom(data);
        setStatus(next);
        if (resetForm) {
          setForm(next.settings);
          setTokenInput('');
          setPasswordInput('');
        }
        return next;
      }, []);

      const loadStatus = React.useCallback(
        async (resetForm) => {
          setLoad({ phase: 'loading', error: null });
          try {
            const data = await requestJson('GET');
            if (!mounted.current) return;
            applyStatus(data, resetForm);
            setLoad({ phase: 'ready', error: null });
          } catch (error) {
            if (!mounted.current) return;
            setLoad({ phase: 'error', error: messageOf(error) });
          }
        },
        [applyStatus],
      );

      React.useEffect(() => {
        void loadStatus(true);
      }, [loadStatus]);

      const patch = (key, value) => {
        setForm((previous) => (previous === null ? previous : { ...previous, [key]: value }));
      };

      const patchGroup = (group, key, value) => {
        setForm((previous) =>
          previous === null ? previous : { ...previous, [group]: { ...previous[group], [key]: value } },
        );
      };

      const toggleEvent = (key) => {
        setForm((previous) => {
          if (previous === null) return previous;
          const picked = previous.events.indexOf(key) !== -1;
          const next = new Set(previous.events);
          if (picked) next.delete(key);
          else next.add(key);
          return { ...previous, events: EVENT_KEYS.filter((candidate) => next.has(candidate)) };
        });
      };

      const refresh = async () => {
        if (busy !== null) return;
        setBusy('refresh');
        setNotice(null);
        try {
          const data = await requestJson('GET');
          if (!mounted.current) return;
          applyStatus(data, true);
          setLoad({ phase: 'ready', error: null });
        } catch (error) {
          if (!mounted.current) return;
          if (form === null) setLoad({ phase: 'error', error: messageOf(error) });
          else showNotice('error', t('loadFailed') + ' · ' + messageOf(error));
        } finally {
          if (mounted.current) setBusy(null);
        }
      };

      const submitSave = async () => {
        if (form === null || busy !== null) return;
        const serverUrl = form.serverUrl.trim();
        if (serverUrl !== '' && !/^https?:\/\/\S+$/i.test(serverUrl)) {
          showNotice('error', t('errInvalidUrl'));
          return;
        }
        setBusy('save');
        setNotice(null);
        setConfirming(null);
        try {
          const payload = {
            serverUrl,
            topic: form.topic.trim(),
            authMode: form.authMode,
            username: form.username.trim(),
            events: form.events.slice(),
            clickTemplate: form.clickTemplate.trim(),
            clickMode: form.clickMode,
            reply: {
              enabled: form.reply.enabled,
              ttlSec: clampNumber(form.reply.ttlSec, TTL_MIN, TTL_MAX, TTL_DEFAULT),
              webPromptDelaySec: clampNumber(form.reply.webPromptDelaySec, 0, 60, 0),
            },
            quietHours: {
              enabled: form.quietHours.enabled,
              from: form.quietHours.from,
              to: form.quietHours.to,
              urgentBypass: form.quietHours.urgentBypass,
            },
            minIntervalSec: clampNumber(form.minIntervalSec, INTERVAL_MIN, INTERVAL_MAX, INTERVAL_DEFAULT),
            includePreview: form.includePreview,
          };
          const secretToken = form.authMode === 'token' ? tokenInput.trim() : '';
          const secretPassword = form.authMode === 'basic' ? passwordInput.trim() : '';
          // SPEC §2: secrets ride beside `settings`, never inside it.
          const body = { action: 'save', settings: payload };
          if (secretToken !== '') body.token = secretToken;
          if (secretPassword !== '') body.password = secretPassword;
          const data = await requestJson('POST', body);
          if (!mounted.current) return;
          if (data && typeof data.settings === 'object' && data.settings !== null) {
            applyStatus(data, true);
          } else {
            await loadStatus(true);
          }
          if (mounted.current) setNotice({ kind: 'ok', text: t('saved') });
        } catch (error) {
          if (mounted.current) showNotice('error', t('saveFailed') + ' · ' + messageOf(error));
        } finally {
          if (mounted.current) setBusy(null);
        }
      };

      const submitTest = async () => {
        if (busy !== null) return;
        setBusy('test');
        setNotice(null);
        try {
          const data = await requestJson('POST', { action: 'test' });
          if (!mounted.current) return;
          if (data && typeof data.settings === 'object' && data.settings !== null) applyStatus(data, false);
          if (data && data.ok === true) {
            const tail = [];
            if (typeof data.httpStatus === 'number') tail.push('HTTP ' + String(data.httpStatus));
            if (typeof data.detail === 'string' && data.detail !== '') tail.push(data.detail);
            setNotice({
              kind: 'ok',
              text: tail.length > 0 ? t('testSent') + ' · ' + tail.join(' · ') : t('testSent'),
            });
          } else {
            const code = data && typeof data.error === 'string' ? data.error : '';
            const detail = data && typeof data.detail === 'string' ? data.detail : '';
            // SPEC §2 names this `error`; the Host reports it through `detail`.
            const text =
              code === 'not-configured' || detail === 'not-configured'
                ? t('errNotConfigured')
                : t('testFailed') +
                  (code !== '' ? ' · ' + code : '') +
                  (detail !== '' ? ' · ' + detail : '');
            setNotice({ kind: 'error', text });
          }
        } catch (error) {
          if (mounted.current) showNotice('error', t('testFailed') + ' · ' + messageOf(error));
        } finally {
          if (mounted.current) setBusy(null);
        }
      };

      const clearSecret = async (which) => {
        if (busy !== null) return;
        setBusy(which === 'token' ? 'clear-token' : 'clear-password');
        setNotice(null);
        try {
          const data = await requestJson('POST', { action: 'clearSecret', which });
          if (!mounted.current) return;
          if (data && typeof data.settings === 'object' && data.settings !== null) {
            applyStatus(data, false);
          } else {
            await loadStatus(false);
          }
          if (which === 'token') setTokenInput('');
          else setPasswordInput('');
          setConfirming(null);
          if (mounted.current) setNotice({ kind: 'ok', text: t('cleared') });
        } catch (error) {
          if (mounted.current) showNotice('error', t('clearFailed') + ' · ' + messageOf(error));
        } finally {
          if (mounted.current) setBusy(null);
        }
      };

      const copyBase = async () => {
        const base = absoluteUrl(REPLY_PATH);
        const value = base !== '' ? base : REPLY_PATH;
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            await navigator.clipboard.writeText(value);
          } else {
            throw new Error(t('errUnknown'));
          }
          if (!mounted.current) return;
          setCopied(true);
          if (copyTimer.current) window.clearTimeout(copyTimer.current);
          copyTimer.current = window.setTimeout(() => {
            if (mounted.current) setCopied(false);
          }, 1600);
        } catch (error) {
          showNotice('error', t('copy') + ' · ' + messageOf(error));
        }
      };

      // ---- field builders --------------------------------------------
      const textField = (id, label, value, placeholder, hint, onChange) => {
        const parts = [
          h('label', { className: 'ntfy-label', htmlFor: id }, label),
          h('input', {
            id,
            type: 'text',
            className: 'ntfy-input',
            value,
            placeholder: placeholder === '' ? undefined : placeholder,
            spellCheck: false,
            autoComplete: 'off',
            onChange: (event) => onChange(event.target.value),
          }),
        ];
        if (hint !== '') parts.push(h('p', { className: 'ntfy-hint' }, hint));
        return h('div', { className: 'ntfy-field' }, ...parts);
      };

      const timeField = (id, label, value, onChange) =>
        h(
          'div',
          { className: 'ntfy-field' },
          h('label', { className: 'ntfy-label', htmlFor: id }, label),
          h('input', {
            id,
            type: 'time',
            className: 'ntfy-input',
            value,
            onChange: (event) => onChange(event.target.value),
          }),
        );

      const checkRow = (id, label, checked, onChange, hint) => {
        const parts = [
          h(
            'div',
            { className: 'ntfy-check-row' },
            h('input', {
              id,
              type: 'checkbox',
              className: 'ntfy-checkbox',
              checked,
              onChange: (event) => onChange(event.target.checked),
            }),
            h('label', { className: 'ntfy-check-label', htmlFor: id }, label),
          ),
        ];
        if (hint !== '') parts.push(h('p', { className: 'ntfy-hint' }, hint));
        return h('div', { className: 'ntfy-switch' }, ...parts);
      };

      // ---- header ------------------------------------------------------
      const dirty =
        form !== null && status !== null
          ? JSON.stringify(form) !== JSON.stringify(status.settings) ||
            tokenInput.trim() !== '' ||
            passwordInput.trim() !== ''
          : false;

      const header = h(
        'header',
        { className: 'ntfy-head' },
        h(
          'div',
          { className: 'ntfy-head-main' },
          h('h2', { className: 'ntfy-title' }, t('title')),
          h('p', { className: 'ntfy-desc' }, t('desc')),
        ),
        h(
          'div',
          { className: 'ntfy-head-actions' },
          dirty ? h('span', { className: 'ntfy-chip ntfy-chip-warn' }, t('unsaved')) : null,
          h(
            'button',
            {
              type: 'button',
              className: 'ntfy-btn ntfy-btn-ghost',
              disabled: busy !== null,
              onClick: refresh,
            },
            busy === 'refresh' ? t('refreshing') : t('refresh'),
          ),
        ),
      );

      // ---- body --------------------------------------------------------
      let body;
      if (form === null || status === null) {
        body =
          load.phase === 'error'
            ? h(
                'div',
                { className: 'ntfy-note ntfy-note-bad', role: 'status' },
                h('span', { className: 'ntfy-note-text' }, t('loadFailed') + ' · ' + (load.error || '')),
                h(
                  'button',
                  { type: 'button', className: 'ntfy-btn ntfy-btn-ghost', onClick: () => loadStatus(true) },
                  t('retry'),
                ),
              )
            : h('div', { className: 'ntfy-note' }, t('loading'));
      } else {
        const sections = [];

        // saved status
        sections.push(
          h(
            'section',
            { className: 'ntfy-card', key: 'status' },
            h(
              'div',
              { className: 'ntfy-card-head' },
              h('h3', { className: 'ntfy-card-title' }, t('status')),
              h(
                'div',
                { className: 'ntfy-badges' },
                h(
                  'span',
                  { className: 'ntfy-chip ' + (status.configured ? 'ntfy-chip-ok' : 'ntfy-chip-warn') },
                  status.configured ? t('configured') : t('notConfigured'),
                ),
                h(
                  'span',
                  { className: 'ntfy-chip ' + (status.replyReady ? 'ntfy-chip-ok' : 'ntfy-chip-warn') },
                  status.replyReady ? t('replyReady') : t('replyNotReady'),
                ),
              ),
            ),
            h(
              'div',
              { className: 'ntfy-kv' },
              h('span', { className: 'ntfy-kv-k' }, t('tokenLabel')),
              h(
                'span',
                { className: 'ntfy-kv-v' },
                status.credential.token ? t('credentialSet') : t('credentialUnset'),
              ),
              h('span', { className: 'ntfy-kv-k' }, t('passwordLabel')),
              h(
                'span',
                { className: 'ntfy-kv-v' },
                status.credential.password ? t('credentialSet') : t('credentialUnset'),
              ),
              h('span', { className: 'ntfy-kv-k' }, t('lastDelivery')),
              h('span', { className: 'ntfy-kv-v' }, deliveryText(status.lastDelivery, t, loc)),
            ),
          ),
        );

        // server + auth
        const authFields = [];
        if (form.authMode === 'token') {
          authFields.push(
            h(
              'div',
              { className: 'ntfy-field', key: 'token' },
              h('label', { className: 'ntfy-label', htmlFor: 'ntfy-token' }, t('token')),
              h(
                'div',
                { className: 'ntfy-inline' },
                h('input', {
                  id: 'ntfy-token',
                  type: 'password',
                  className: 'ntfy-input',
                  value: tokenInput,
                  placeholder: status.credential.token ? t('configuredPlaceholder') : 'tk_…',
                  spellCheck: false,
                  autoComplete: 'new-password',
                  onChange: (event) => setTokenInput(event.target.value),
                }),
                status.credential.token
                  ? h('span', { className: 'ntfy-chip ntfy-chip-ok' }, t('credentialSet'))
                  : null,
              ),
              h('p', { className: 'ntfy-hint' }, t('tokenHint')),
            ),
          );
        } else if (form.authMode === 'basic') {
          authFields.push(
            h(
              'div',
              { className: 'ntfy-grid ntfy-grid-2', key: 'basic' },
              textField(
                'ntfy-username',
                t('username'),
                form.username,
                '',
                t('usernameHint'),
                (value) => patch('username', value),
              ),
              h(
                'div',
                { className: 'ntfy-field' },
                h('label', { className: 'ntfy-label', htmlFor: 'ntfy-password' }, t('password')),
                h(
                  'div',
                  { className: 'ntfy-inline' },
                  h('input', {
                    id: 'ntfy-password',
                    type: 'password',
                    className: 'ntfy-input',
                    value: passwordInput,
                    placeholder: status.credential.password ? t('configuredPlaceholder') : undefined,
                    spellCheck: false,
                    autoComplete: 'new-password',
                    onChange: (event) => setPasswordInput(event.target.value),
                  }),
                  status.credential.password
                    ? h('span', { className: 'ntfy-chip ntfy-chip-ok' }, t('credentialSet'))
                    : null,
                ),
                h('p', { className: 'ntfy-hint' }, t('passwordHint')),
              ),
            ),
          );
        } else {
          authFields.push(h('p', { className: 'ntfy-hint', key: 'none' }, t('authNoneHint')));
        }

        sections.push(
          h(
            'section',
            { className: 'ntfy-card', key: 'server' },
            h('div', { className: 'ntfy-card-head' }, h('h3', { className: 'ntfy-card-title' }, t('serverSection'))),
            textField('ntfy-server', t('serverUrl'), form.serverUrl, 'https://ntfy.sh', t('serverUrlHint'), (value) =>
              patch('serverUrl', value),
            ),
            textField('ntfy-topic', t('topic'), form.topic, 'my-dsh-alerts', t('topicHint'), (value) => patch('topic', value)),
            h(
              'div',
              { className: 'ntfy-field' },
              h('label', { className: 'ntfy-label', htmlFor: 'ntfy-auth' }, t('authMode')),
              h(
                'select',
                {
                  id: 'ntfy-auth',
                  className: 'ntfy-input',
                  value: form.authMode,
                  onChange: (event) =>
                    patch('authMode', AUTH_MODES.indexOf(event.target.value) === -1 ? 'token' : event.target.value),
                },
                AUTH_MODES.map((mode) =>
                  h(
                    'option',
                    { key: mode, value: mode },
                    mode === 'none' ? t('authNone') : mode === 'token' ? t('authToken') : t('authBasic'),
                  ),
                ),
              ),
            ),
            ...authFields,
          ),
        );

        // events
        const eventRows = EVENT_KEYS.map((key) =>
          checkRow(
            'ntfy-event-' + key,
            t(EVENT_LABEL[key]),
            form.events.indexOf(key) !== -1,
            () => toggleEvent(key),
            '',
          ),
        );
        sections.push(
          h(
            'section',
            { className: 'ntfy-card', key: 'events' },
            h('div', { className: 'ntfy-card-head' }, h('h3', { className: 'ntfy-card-title' }, t('eventsSection'))),
            h('p', { className: 'ntfy-hint' }, t('eventsHint')),
            h('div', { className: 'ntfy-checks' }, ...eventRows),
            form.events.length === 0 ? h('p', { className: 'ntfy-hint ntfy-hint-warn' }, t('eventsNone')) : null,
          ),
        );

        // click target + replies
        const replyBase = absoluteUrl(REPLY_PATH);
        const replyBaseShown = (replyBase !== '' ? replyBase : REPLY_PATH) + '?t=…';
        sections.push(
          h(
            'section',
            { className: 'ntfy-card', key: 'reply' },
            h('div', { className: 'ntfy-card-head' }, h('h3', { className: 'ntfy-card-title' }, t('clickSection'))),
            h(
              'div',
              { className: 'ntfy-field', key: 'click-mode' },
              h('label', { className: 'ntfy-label', htmlFor: 'ntfy-click-mode' }, t('clickMode')),
              h(
                'select',
                {
                  id: 'ntfy-click-mode',
                  className: 'ntfy-input',
                  value: form.clickMode,
                  onChange: (event) =>
                    patch(
                      'clickMode',
                      ['token', 'plain', 'none'].indexOf(event.target.value) === -1 ? 'token' : event.target.value,
                    ),
                },
                ['token', 'plain', 'none'].map((mode) =>
                  h(
                    'option',
                    { key: mode, value: mode },
                    mode === 'token' ? t('clickModeToken') : mode === 'plain' ? t('clickModePlain') : t('clickModeNone'),
                  ),
                ),
              ),
              h('p', { className: 'ntfy-hint' }, t('clickModeHint')),
            ),
            textField(
              'ntfy-click',
              t('clickTemplate'),
              form.clickTemplate,
              'https://dsh.example.com/?session={sessionId}',
              t('clickTemplateHint'),
              (value) => patch('clickTemplate', value),
            ),
            checkRow(
              'ntfy-reply-enabled',
              t('replyEnabled'),
              form.reply.enabled,
              (value) => patchGroup('reply', 'enabled', value),
              t('replyEnabledHint'),
            ),
            h(
              'div',
              { className: 'ntfy-field' },
              h('label', { className: 'ntfy-label', htmlFor: 'ntfy-reply-ttl' }, t('replyTtl')),
              h(NumberField, {
                id: 'ntfy-reply-ttl',
                value: form.reply.ttlSec,
                min: TTL_MIN,
                max: TTL_MAX,
                step: 1,
                onChange: (value) => patchGroup('reply', 'ttlSec', value),
              }),
              h('p', { className: 'ntfy-hint' }, t('replyTtlHint')),
            ),
            h(
              'div',
              { className: 'ntfy-field' },
              h('label', { className: 'ntfy-label', htmlFor: 'ntfy-web-delay' }, t('webPromptDelay')),
              h(NumberField, {
                id: 'ntfy-web-delay',
                value: form.reply.webPromptDelaySec,
                min: 0,
                max: 60,
                step: 1,
                onChange: (value) => patchGroup('reply', 'webPromptDelaySec', value),
              }),
              h('p', { className: 'ntfy-hint' }, t('webPromptDelayHint')),
            ),
            h(
              'div',
              { className: 'ntfy-field' },
              h('label', { className: 'ntfy-label', htmlFor: 'ntfy-reply-base' }, t('replyBase')),
              h(
                'div',
                { className: 'ntfy-inline' },
                h('code', { id: 'ntfy-reply-base', className: 'ntfy-mono' }, replyBaseShown),
                h(
                  'button',
                  { type: 'button', className: 'ntfy-btn ntfy-btn-ghost', onClick: copyBase },
                  copied ? t('copied') : t('copy'),
                ),
              ),
              h('p', { className: 'ntfy-hint' }, t('replyBaseHint')),
            ),
            status.replyReady
              ? null
              : h('div', { className: 'ntfy-note ntfy-note-warn' }, h('span', { className: 'ntfy-note-text' }, t('replyNotReadyHint'))),
          ),
        );

        // quiet hours + pacing
        const quietFields = [];
        if (form.quietHours.enabled) {
          quietFields.push(
            h(
              'div',
              { className: 'ntfy-grid ntfy-grid-2', key: 'range' },
              timeField('ntfy-quiet-from', t('quietFrom'), form.quietHours.from, (value) =>
                patchGroup('quietHours', 'from', value),
              ),
              timeField('ntfy-quiet-to', t('quietTo'), form.quietHours.to, (value) =>
                patchGroup('quietHours', 'to', value),
              ),
            ),
            checkRow(
              'ntfy-quiet-bypass',
              t('quietBypass'),
              form.quietHours.urgentBypass,
              (value) => patchGroup('quietHours', 'urgentBypass', value),
              t('quietBypassHint'),
            ),
          );
        }
        sections.push(
          h(
            'section',
            { className: 'ntfy-card', key: 'quiet' },
            h('div', { className: 'ntfy-card-head' }, h('h3', { className: 'ntfy-card-title' }, t('quietSection'))),
            checkRow(
              'ntfy-quiet-enabled',
              t('quietEnabled'),
              form.quietHours.enabled,
              (value) => patchGroup('quietHours', 'enabled', value),
              '',
            ),
            ...quietFields,
            h(
              'div',
              { className: 'ntfy-field' },
              h('label', { className: 'ntfy-label', htmlFor: 'ntfy-min-interval' }, t('minInterval')),
              h(NumberField, {
                id: 'ntfy-min-interval',
                value: form.minIntervalSec,
                min: INTERVAL_MIN,
                max: INTERVAL_MAX,
                step: 1,
                onChange: (value) => patch('minIntervalSec', value),
              }),
              h('p', { className: 'ntfy-hint' }, t('minIntervalHint')),
            ),
            checkRow(
              'ntfy-preview',
              t('preview'),
              form.includePreview,
              (value) => patch('includePreview', value),
              t('previewHint'),
            ),
          ),
        );

        // actions
        sections.push(
          h(
            'section',
            { className: 'ntfy-card', key: 'actions' },
            notice !== null
              ? h(
                  'div',
                  { className: 'ntfy-note ntfy-note-' + notice.kind, role: 'status', 'aria-live': 'polite' },
                  h('span', { className: 'ntfy-note-text' }, notice.text),
                )
              : null,
            h(
              'div',
              { className: 'ntfy-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'ntfy-btn ntfy-btn-primary',
                  disabled: busy !== null,
                  onClick: submitSave,
                },
                busy === 'save' ? t('saving') : t('save'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ntfy-btn ntfy-btn-ghost',
                  disabled: busy !== null,
                  onClick: submitTest,
                },
                busy === 'test' ? t('testing') : t('test'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'ntfy-btn ntfy-btn-ghost ntfy-btn-danger',
                  disabled: busy !== null || !status.credential.token,
                  onClick: () => {
                    setConfirming('token');
                    setNotice(null);
                  },
                },
                busy === 'clear-token' ? t('clearing') : t('clearToken'),
              ),
              status.credential.password
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'ntfy-btn ntfy-btn-ghost ntfy-btn-danger',
                      disabled: busy !== null,
                      onClick: () => {
                        setConfirming('password');
                        setNotice(null);
                      },
                    },
                    busy === 'clear-password' ? t('clearing') : t('clearPassword'),
                  )
                : null,
            ),
            h('p', { className: 'ntfy-hint' }, t('testNeedsSaved')),
            confirming !== null
              ? h(
                  'div',
                  { className: 'ntfy-confirm' },
                  h(
                    'span',
                    { className: 'ntfy-confirm-text' },
                    confirming === 'token' ? t('confirmClearToken') : t('confirmClearPassword'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ntfy-btn ntfy-btn-danger',
                      disabled: busy !== null,
                      onClick: () => clearSecret(confirming),
                    },
                    t('confirm'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'ntfy-btn ntfy-btn-ghost',
                      disabled: busy !== null,
                      onClick: () => setConfirming(null),
                    },
                    t('cancel'),
                  ),
                )
              : null,
          ),
        );

        body = sections;
      }

      return h('div', { className: 'ntfy-section' }, header, body);
    }

    // ------------------------------------------------------------------
    // plugin body
    // ------------------------------------------------------------------
    return {
      inject: ['slots'],
      apply(ctx) {
        const locale = ctx.get('locale');
        let t = (key) => DICTS.zh[key] ?? DICTS.en[key] ?? key;
        // Kept in an object so the registration callback (which runs on every
        // render) reads the current language for date formatting, not the
        // language that happened to be active when apply() ran.
        const localeState = { loc: 'en' };
        if (locale && typeof locale.register === 'function') {
          const disposeLocale = locale.register(NS, { zh: DICTS.zh, en: DICTS.en });
          if (typeof disposeLocale === 'function') {
            ctx.effect(() => disposeLocale, 'dsh-ntfy-push: locale');
          }
          if (typeof locale.bind === 'function') t = locale.bind(NS);
          try {
            const snapshot = typeof locale.getLocale === 'function' ? locale.getLocale() : null;
            if (snapshot && snapshot.active) {
              localeState.loc = String(snapshot.active).startsWith('zh') ? 'zh' : 'en';
            }
          } catch {
            /* keep the English fallback */
          }
          if (typeof locale.subscribe === 'function') {
            try {
              ctx.effect(
                () =>
                  locale.subscribe((snapshot) => {
                    if (snapshot && snapshot.active) {
                      localeState.loc = String(snapshot.active).startsWith('zh') ? 'zh' : 'en';
                    }
                  }),
                'dsh-ntfy-push: locale tracking',
              );
            } catch {
              /* fall back to the language captured at apply() time */
            }
          }
        }

        const style = document.createElement('style');
        style.textContent = CSS;
        style.setAttribute('data-plugin', 'dsh-ntfy-push');
        document.head.appendChild(style);
        ctx.effect(() => () => style.remove(), 'dsh-ntfy-push: styles');

        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            {
              name: SLOT,
              id: SLOT_ID,
              order: SLOT_ORDER,
              // The nav label is a thunk: the settings shell re-reads it when
              // the locale changes (same pattern as the shipped sections).
              label: () => t('nav'),
              locale: NS,
            },
            (props) => h(NtfySettings, { ...props, t, loc: localeState.loc }),
          ),
        );
      },
    };
  },
});