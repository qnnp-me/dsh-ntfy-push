# dsh-ntfy-push — 内部契约（Host ↔ Client）

插件包 `dsh-ntfy-push`：把 DSH 的任务事件推到**任意 ntfy 服务器**（自建/公网/私网均可，支持 token / basic / 无认证），
并允许**直接从手机通知上的按钮回执**审批与提问。

本文件是 Host 半（`index.js`）与 Client 半（`client.js`）的唯一契约。改契约先改这里。

---

## 1. 配置（cordis.patch.yml 的 config，Standard Schema）

| key | 类型 | 默认 | 说明 |
|---|---|---|---|
| `serverUrl` | string | `https://ntfy.sh` | ntfy 服务器根地址，末尾斜杠自动去掉。允许私网/回环（这是用户自己的服务器，不做 SSRF 白名单） |
| `topic` | string | `''` | 目标 topic；空 = 不推送（面板会提示未配置） |
| `authMode` | `'none' \| 'token' \| 'basic'` | `'token'` | `token` → `Authorization: Bearer <token>`；`basic` → `Authorization: Basic <base64(user:pass)>` |
| `tokenRef` | string | `NTFY_PUSH_TOKEN` | 凭据库 key（token 不落 config、不落工作区） |
| `passwordRef` | string | `NTFY_PUSH_PASSWORD` | basic 认证密码的凭据库 key |
| `username` | string | `''` | basic 认证用户名（非机密，可落 config） |
| `events` | string[] | 全部 6 类 | 见 §4 |
| `priority` | object | `{approval:5, question:4, turnEnd:3, error:5, subagent:2, workflow:2}` | 1–5 |
| `tags` | object | 见 §5 | 每类事件的 ntfy tags |
| `clickTemplate` | string | `''` | 自定义点击 URL，填写后覆盖 `clickMode`；支持 `{sessionId}` `{title}` 占位 |
| `clickMode` | `'token' \| 'plain' \| 'none'` | `'token'` | 点通知的行为：`token` = 用 `connection.authenticatedUrl` 拼上本次进程登录令牌；`plain` = 裸地址（手机需已有 cookie）；`none` = 不跳转 |

两种情况下的 `click` 都先落到同源过渡页 `/dsh-ntfy-push/open?u=<signed-url>`，再由页面 `location.replace` 跳到目标：DSH 登录 cookie 是
`SameSite=Strict`，从第三方 App（ntfy 通知）跨站直接打开 token URL 时，服务端 303 的第二跳不带 cookie，会落到 401；先加载同源页面使 token
导航变成 same-site。过渡页只接受同源目标（防开放重定向）。
| `reply.enabled` | boolean | `true` | 通知里放「回执按钮」 |
| `reply.ttlSec` | number | `600` | 回执令牌有效期 |
| `reply.webPromptDelaySec` | number | `0` | 0 = 网页立刻弹，手机作答后卡片自动消失（默认）；>0 = 先等手机这么多秒再弹网页，窗口内手机作答则网页全程不弹 |
| `quietHours.enabled` | boolean | `false` | 免打扰 |
| `quietHours.from` / `to` | `HH:mm` | `23:00` / `08:00` | 跨零点自动处理 |
| `quietHours.urgentBypass` | boolean | `true` | priority 5 穿透免打扰 |
| `minIntervalSec` | number | `20` | 同一会话同类事件的最小间隔 |
| `includePreview` | boolean | `true` | 回合结束通知是否带最后一段助手正文（截断 160 字） |

面板修改的运行时设置写入 `<DSH_HOME>/dsh-ntfy-push/settings.json`（0600），**覆盖** patch config 的同名字段；
patch config 仍是默认值来源。HMAC 密钥 `<DSH_HOME>/dsh-ntfy-push/hmac.key`（0600，首次生成）。

## 2. Host 认证 API（浏览器内，走 DSH 的 `/api` 鉴权）

`connection.fetch.register({ path: '/api/dsh-ntfy-push', methods: ['GET','POST'], requestBody: 'buffered' })`

### GET → 状态

```json
{
  "ok": true,
  "configured": false,
  "settings": { "...": "§1 全字段，无密钥" },
  "credential": { "token": false, "password": false, "source": "none" },
  "lastDelivery": { "at": 1793627707845, "ok": true, "event": "test", "detail": "HTTP 200" },
  "replyReady": false
}
```

`configured` = `serverUrl` + `topic` 非空。`replyReady` = `reply.enabled` 且 能算出回执基址。

### POST → 动作

```json
{ "action": "save", "settings": { "...": "§1 任意子集" }, "token": "tk_xxx?", "password": "xxx?" }
{ "action": "test" }
{ "action": "clearSecret", "which": "token" | "password" }
```

- `save`：合并并落盘；`token`/`password` 出现且非空时写入凭据库，**响应绝不回显**。
- `test`：真实发一条测试通知，返回 `{ ok, httpStatus, detail }`。
- 所有响应都带 §「GET」同构的状态，便于前端一次刷新。

### 认证失败/未配置

未配置时 `test` 返回 `{ ok:false, detail:'not-configured' }`（与其它投递失败一致走 `detail`），不抛异常。

## 3. 公开回执路由（raw webServer，**不走 /api 鉴权**）

`POST|GET /dsh-ntfy-push/reply?t=<signed-token>&format=json?`

- 手机 ntfy 动作按钮命中它；`GET` 返回一个可在手机浏览器打开的极简 HTML 结果页，`format=json` 返回 JSON。
- 令牌：`base64url(JSON{n:nonce, e:expSec, k:'approval'|'question', v:value}) + '.' + base64url(HMAC-SHA256(secret, payload))`
- 校验：签名（`timingSafeEqual`）→ 未过期 → nonce 未被消费 → kind 有对应待决请求
- 一次性：成功消费后从 pending 表移除；重复点击返回 **200 + `already:true`**「已处理或已失效」（幂等，避免 App 重试风暴和错误页）
- 响应码：200 成功（含重复点击）/ 400 参数错 / 403 签名错 / 410 令牌过期 / 404 未知

## 4. 事件 → 通知

| event key | 事件源 | 标题 | 正文 | 回执 |
|---|---|---|---|---|
| `approval` | `approval/request` (waterfall) | `需要你批准：<toolName>` | 会话标题 + `reason` | `[批准][拒绝][打开]`，回执结果 = `'allowed-once'` / `'rejected'` |
| `question` | `user-questions/request` (waterfall) | `等你回答` | 问题文本 | 单选时每个选项一个按钮（**≤3 个**，占满 ntfy 的 3 个动作位）；>3 选项仅靠点通知正文打开 DSH |
| `turnEnd` | `agent/status` running→idle | `跑完了：<title>` | 可选正文预览 | 仅 `[打开]` |
| `error` | `agent/error` | `出错：<title>` | 错误摘要 | 仅 `[打开]` |
| `subagent` | `subagent/end` | `子任务结束` | 子代理名/结果 | 仅 `[打开]` |
| `workflow` | `workflow/end` | `工作流结束` | 运行名/结果 | 仅 `[打开]` |

ntfy `actions` **最多 3 个**。额度优先级：回执按钮 > 打开。若回执 2 个则 `[批准][拒绝][打开]` 正好 3 个。

### 抢答语义（关键）

`approval/request` / `user-questions/request` 是 waterfall：
1. 先 `next()` 交给原生 UI（浏览器里照常弹审批/提问）；
2. 同时把带令牌的通知推出去，登记 pending；
3. owner = `Promise.race([uiResult, phoneReply])`，手机先回则用自己的 outcome 返回；
4. 任一方先决出即清理 pending（令牌立即失效）。

## 5. ntfy 发布（JSON 发布，避免 header 的 UTF-8 问题）

```
POST {serverUrl}/
Authorization: Bearer <token> | Basic <base64>   (authMode)
Content-Type: application/json

{ "topic":"...", "title":"...", "message":"...", "priority":4,
  "tags":["warning"], "click":"https://...",
  "actions":[{"action":"http","label":"批准","url":"https://.../dsh-ntfy-push/reply?t=...","method":"POST","clear":true},
             {"action":"view","label":"打开","url":"https://..."}] }
```

默认 tags：approval `rotating_light`、question `question`、turnEnd `heavy_check_mark`、error `warning`、subagent/workflow `arrow_forward`。
消息体 ≤4096 字节（超长截断，正文预览 160 字）。

## 6. Client 半

- 模块形态：`window.__ModuleLoader__.load({ id:'dsh-ntfy-push', factory(require){...} })`
- 注入 `@deepseek-ai/dsh-client-ui-settings`，在 **`settings.section`** 注册一页：
  `ctx.slots.inject('settings.section', () => ctx.slots.register({ name:'settings.section', id:'dsh-ntfy-push', order: <数值>, label:<本地化标题> }, component))`
- Boot 常量由 Host 通过 `webServer.tapIndex` 注入：`window.__DSH_NTFY_PUSH_BOOT__ = { route:'/api/dsh-ntfy-push', replyPath:'/dsh-ntfy-push/reply' }`
- 页面内容：服务器地址 / topic / 认证方式 / 用户名 / token / 密码（占位「已配置」不回显）/ 6 类事件开关 /
  点击地址模板 / 回执开关+有效期 / 免打扰 / 最小间隔 / 预览开关 / [保存][发送测试][清除 Token] / 最近投递状态 / 回执基址提示
- 文案走 Client locale 服务（`ctx.get('locale')`），字典同时内置 zh/en 兜底（与千帆插件同法）
- 样式继承主题 token（`var(--dsh-*)`），不引第三方依赖
- **不得**读写任何其它插件 DOM；只用该槽 props

## 7. 安全约束

- token / password 只进凭据库；API 响应只回布尔；日志不打印值
- 回执 URL 含一次性签名，**不带** DSH 登录凭据
- 回执路由不读请求体里的任何「命令」，只认签名里的 `v`（白名单值域）
- settings.json / hmac.key 0600，目录 0700