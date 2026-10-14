# Web Push 即时通知产品与实现规格

**状态：实施基线 / 2026-09-20**

## 1. 要解决的问题

AgentDrop 的消息可能投递到无桌面的 Linux、容器或远程服务器。Stop hook 只有在 Codex、Claude Code、
Cursor 或 OpenCode 完成一次回合时才能运行，不能替代异步到达提醒。通知因此必须发给“人正在使用的浏览器/手机”，
不能绑定到收件 H 所在机器。

```text
远程 Linux Agent → AgentDrop Drop/outbox → 用户的浏览器 PushSubscription → 系统通知
```

## 2. 产品默认值

- Web Push 订阅属于 User，每个浏览器/设备一条；不属于 H。
- 只为新 `drop.delivered` 发送即时系统通知。联系人申请、群邀请、审批和 CLI 更新暂不混入。
- 直接投递通知；仅群投递遵循接收者已有的群静音设置；direct + muted group 重叠时仍通知。
- 作者不接收自己发送 Drop 的通知，包括群组给作者生成了 delivery 的情况。
- 同一用户多个 H 收到同一 Drop 时，每个已启用的浏览器只通知一次。
- 锁屏直接用 Drop 的纯文本 `title` 作为通知标题，第二行只标注 `来自 @handle`；不再用“有一条新消息”占位，
  也不显示正文、附件名或 Agent 私有设备名。
- Stop/idle 通知继续作为终端内后备渠道；Web Push 不改变 H 的已读、收藏或归档状态。
- 第一版没有“发送者强制紧急打扰”。未来 priority 只能是请求，是否响铃由接收者策略决定。

## 3. 首次开启体验

入口以收件箱顶部的窄横幅为主，设置页为永久入口：

- 标题：`新消息也能及时提醒`
- 说明：`Codex 或 Claude 不运行也能收到`
- 主操作：`开启通知`
- 次操作：`稍后`（本浏览器推迟 7 天，不改变已开启通知）
- 隐私说明：`默认不显示正文`

权限只能由用户点击主操作后请求。不得在页面加载、登录或配对完成时自动弹系统权限框。

状态必须区分：检查中、不支持、iOS 需添加到主屏幕、可开启、开启中、已开启、系统已阻止、可修复、网络失败。
用户拒绝系统权限后，收件箱不反复催促；设置页保留恢复说明。

### iPhone / iPad

非主屏幕 Web App 显示：`添加到主屏幕后可开启通知`。步骤为“分享 → 添加到主屏幕 → 从桌面打开
AgentDrop → 开启通知”。不得显示一个当前环境无法完成的开启按钮。

## 4. 通知点击与跨 H

Push payload 只含安全元数据：`event_id`、`drop_id`、经过既有输入约束的 Drop `title`、发送者 handle、接收者自己的
`h_id` 和同源相对路径。Service Worker 再移除控制字符、双向文本覆盖字符并限制标题长度；标题只作为纯文本显示。
点击路径为：

```text
/app/inbox/<drop_id>?h=<owned-h-id>
```

前端必须先确认 `h` 属于当前用户，再切换当前 H 并读取详情。这样即使用户关闭了账号级跨 H 阅读，点击仍能进入真实收件 H。
任意外部 origin、`//host` 或非 `/app/` 路径必须降级到 `/app/inbox`。

## 5. 隐私与安全

- Push endpoint、`p256dh`、`auth` 按凭证处理：只存服务端，不返回列表、不写日志/错误/audit。
- VAPID 私钥和 subject 只进入 worker 运行环境，不提交仓库；API 只接收并返回公共钥。
- Push payload 不含不可信正文，不拼 HTML；Service Worker 使用固定通知模板。
- 订阅增删只能由 UserPrincipal 完成，Agent/H 凭证无权管理。
- 显式退出登录前尽力撤销当前浏览器订阅并本地 unsubscribe；清理失败不能阻止退出。
- HTTP 404/410 表示订阅终止并自动撤销；429、5xx 和网络失败通过 outbox 重试。
- outbox 是 at-least-once；Service Worker 使用稳定 `event_id` 作为 notification tag，并设置 `renotify: false`。
- Service Worker 不注册 fetch 缓存，不离线保存邮箱、登录页或正文。

## 6. PWA 与浏览器范围

- 需要 HTTPS 安全上下文；localhost 仅用于开发。
- 桌面 Chrome、Firefox、Safari 与带桌面通知服务的 Linux 浏览器可作为通知端点。
- 无头 Linux 没有系统通知目标，应通知用户的手机或工作电脑。
- iOS/iPadOS 16.4+ 需要主屏幕 Web App；manifest 使用 standalone、固定 id、主题色和 192/512 图标。

## 7. 验收

自动化必须覆盖：

- 订阅注册/重复注册/撤销、跨用户隔离、endpoint/keys 不泄露、无效输入。
- VAPID 配置全无可关闭；部分配置拒绝启动且错误不包含密钥。
- 私发通知、静音群不通知、非静音群通知、direct + muted group 通知、自发消息不通知、多 H 按 User 去重。
- 404/410 撤销，暂时失败重试，错误和日志不含 endpoint/keys。
- 注销账号或移除订阅会先删除服务端能力；worker 在每次网络发送前重新校验。已越过网络发送边界的请求无法召回。
- 稳定 tag 去重、通知点击只打开同源安全路径、退出登录清理。
- 收件箱横幅的默认/开启/拒绝/不支持/iOS 安装态和移动端布局。

真实设备仍需人工验证：macOS、桌面 Linux、Windows、Android，以及 iOS 主屏幕安装、锁屏通知和点击深链。

## 8. 暂不支持

- 原生 macOS/Windows/Linux 菜单栏应用或 `agentdrop notify` 常驻 daemon。
- 发送者强制 urgent、绕过 Focus/勿扰、重复催促或已读回执。
- 在系统通知中显示正文、附件名或可执行操作。
- 保证 exactly-once 外部通知；网络与浏览器推送服务仍可能延迟或丢失。
