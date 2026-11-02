# dsh-ntfy-push

把 [DeepSeek Harness](https://github.com/deepseek-ai) 的任务事件推到**你自己的 ntfy 服务器**，并允许**直接在手机通知上批准/作答**。

Push DeepSeek Harness task events (approvals, questions, turn ends, errors, subagent/workflow completions) to **your own ntfy server**, and answer them straight from the phone notification — no relay service, no extra app.

## 功能 / Features

- **任意 ntfy 服务器**：`https://ntfy.sh`、自建域名、`http://192.168.x.x:2586`、Tailscale 地址都行（不做私网拦截，因为服务器是你自己的）
- **四种认证**：无 / Access token（Bearer）/ Basic / 用户名+密码；token 只进 DSH 凭据库，面板只显示「已配置」
- **六类事件**独立开关：审批等待、提问等待、回合结束、出错、子任务结束、工作流结束
- **手机回执**（双向）：
  - 审批：`[批准] [拒绝] [打开 DSH]`
  - 提问：单选时每个选项一个按钮（最多 3 个，正好占满 ntfy 的动作位数）
  - 手机作答后，网页上的问答/审批卡片会**在结算后自动收起**
  - 网页先答则手机按钮失效，再点显示「已处理」（幂等，不报错）
- **点击通知正文**：经同源过渡页打开**已登录**的 DSH（绕过 `SameSite=Strict` 的跨站 cookie 问题）
- **可调**：免打扰时段（紧急穿透）、同会话限流、正文预览、点击 URL 模板、优先级 / tags、「先等手机」窗口
- **安全**：回执按钮是一次性 HMAC 签名 URL（过期 + 单次消费 + 值域白名单），不带任何 DSH 登录凭据

## 安装 / Install

要求 DSH ≥ `0.2.1-rc.5`（在 `0.2.1-rc.5` 上实测）。

```bash
# 1) clone 后按本地包安装（已验证的路径）
git clone https://github.com/qnnp-me/dsh-ntfy-push.git
dsh plugin --profile web add file:$PWD/dsh-ntfy-push

# 2) 或直接指定 git 地址（已实测：全新 profile 安装 → 启动正常，无需批准构建脚本）
dsh plugin --profile web add github:qnnp-me/dsh-ntfy-push

# bundle 层只在启动时组合，安装后重启一次
supervisorctl -c /path/to/supervisord.conf restart dsh-web
# 或你平时启动 dsh web 的方式（dsh web / systemd / pm2 ...）
```

两条路径都在 `0.2.1-rc.5` 的全新 profile 里实测过：`dsh plugin add` 会自动把包装进
profile `package.json` 的 `dsh.profile.bundles`，重启后插件加载（日志 `[dsh-ntfy-push] ready`）。

在 DSH 里也可以用 `plugin_manager install_bundle`，target 传 `/path/to/dsh-ntfy-push`（本地 clone）或 `github:qnnp-me/dsh-ntfy-push`。

装好后刷新网页，进入 **设置 → 通知推送**。

## 配置 / Configure

| 字段 | 说明 |
|---|---|
| 服务器地址 | 例：`https://ntfy.example.com`，或 `http://192.168.1.10:2586` |
| Topic | 手机订阅的那个 topic；留空 = 不推送 |
| 认证方式 | `无` / `Access token` / `Basic`；token/password 存入 DSH 凭据库，保存后只显示「已配置」 |
| 事件开关 | 六类事件任意组合 |
| 点击通知打开 | 默认 `自动登录`：URL 带本次进程令牌，手机点开直接进入 DSH（令牌随重启轮换）；可选 `仅打开地址` / `不跳转` |
| 点击地址模板 | 填写后覆盖上面的方式，支持 `{sessionId}` `{title}` 占位 |
| 回执 | 开关 + 令牌有效期（默认 600 秒） |
| 先等手机（秒） | `0`（默认）= 网页与通知同时弹，手机作答后网页卡片自动消失；大于 0 = 先等手机 N 秒再弹网页，窗口内作答则网页全程不弹 |
| 免打扰 | 起止时间 + 「priority 5 穿透」 |
| 最小间隔 | 同一会话同类被动事件的最小推送间隔（审批/提问不受限） |

也可以直接改 profile 的 `cordis.patch.yml`（省略的键用默认值）：

```yaml
- id: dsh-ntfy-push
  config:
    serverUrl: https://ntfy.example.com
    topic: my-dsh-alerts
    authMode: token
    events: [approval, question, turnEnd, error]
```

面板里点 **发送测试**，手机会立刻收到一条测试通知。

## 手机端 / Phone

1. 安装 ntfy App，订阅你的 topic（自建服务器记得在 App 里改 server 地址）
2. 审批通知直接点 **批准 / 拒绝**；提问通知点选项按钮
3. 点通知正文可打开 DSH（默认自动登录）

> ntfy 每条消息最多 3 个动作按钮；`broadcast` 只有 Android 支持，本插件用的是 `http` / `view`（[iOS 也支持](https://raw.githubusercontent.com/binwiederhier/ntfy-ios/refs/heads/main/docs/FEATURE_PARITY.md)）。
> 单条消息体上限 4 KB，插件会自动截断正文。

## 安全模型 / Security

- 回执路由 `/dsh-ntfy-push/reply?t=…` 故意**不走 `/api` 浏览器鉴权**（手机不可能带 DSH cookie），授权依据是令牌本身：HMAC-SHA256、含过期时间、**单次可用**、只接受 `approval` 白名单值与选项下标
- 令牌过期返回 `410`；重复点击返回 `200 {"already":true}`；签名错误返回 `403`
- 平台反代若无前置认证，这条 URL 等于「一次审批权」，**不要转发给别人**
- ntfy token / basic 密码只存 DSH 凭据库；`<DSH_HOME>/dsh-ntfy-push/{settings.json,hmac.key}` 为 `0600`，目录 `0700`
- 不做私网/回环 SSRF 拦截：事件出站走 Host 进程，服务器是你自己的

## 事件与文案 / Events

| 事件 | 时机 | 标题 |
|---|---|---|
| `approval` | `approval/request`（工具需要你批准） | 需要你批准：`<toolName>` |
| `question` | `user-questions/request` | 等你回答：`<问题>` |
| `turnEnd` | `agent/status` running→idle | 跑完了：`<会话标题>` |
| `error` | `agent/error` | 出错：`<会话标题>` |
| `subagent` | `subagent/end` | 子任务结束：`<provider>` |
| `workflow` | `workflow/end` | 工作流结束：`<name>` |

## 自检 / Verify

```bash
# 离线自测：mock ntfy，覆盖发布报文、Bearer 头、审批/提问回执、单次消费、签名拒绝、免打扰、设置 API
node test/selftest.mjs

# 部署后（把地址换成你的 DSH）
curl -s https://your-dsh.example.com/dsh-ntfy-push/health          # {"ok":true,...}
curl -s "https://your-dsh.example.com/dsh-ntfy-push/reply?t=bogus" # 403
curl -s -o /dev/null -w '%{http_code}\n' https://your-dsh.example.com/api/dsh-ntfy-push  # 401（未登录）
```

## 排障 / Troubleshooting

| 现象 | 处理 |
|---|---|
| 手机没收到 | 面板看「最近投递」HTTP 状态；401/403 是 ntfy token/topic 权限；`missing-credential` 是 token 没保存 |
| 点通知弹「要认证」 | 用默认「自动登录」；选「仅打开地址」则需手机浏览器先登录过 DSH；重启后令牌会换，请用新通知 |
| 点按钮没反应 | 确认 `replyReady` 为 true（DSH 公网地址不可用时回执关闭）；令牌过期显示「已过期」，重复点击显示「已处理」 |
| 手机答完网页卡片不消失 | 默认窗口 0 会自动消失；若没消失，确认没有把「先等手机（秒）」设得过大导致旧请求残留 |
| 私网 ntfy 连不上 | Host 进程需能路由到该地址；先在容器里 `curl` 试一次 |

## 已知限制 / Limits

- ntfy 每条最多 3 个动作按钮、消息体 4 KB → 提问选项 >3 或批量提问时只给「打开 DSH」
- 批量提问（一次多个问题）无法在通知上逐个作答
- 审批卡片依赖 DSH 的 waterfall 通路，无 external-settle 接口；同版本 DSH 下实测随结算收起

## 许可 / License

MIT © qnnp-me
