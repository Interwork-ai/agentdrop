# AgentDrop v0.2 实施规格

> **Historical baseline.** This is the v0.2 design specification the implementation started from. Much of it still
> holds, but later decisions changed parts of it: where this text and a record in [`docs/adr/`](../adr/README.md)
> disagree, the ADR wins. The main superseding records are [0005](../adr/0005-dashboard-open-marks-read.md) (opening
> a drop in the dashboard marks it read), [0006](../adr/0006-groups-receive-with-all-agents.md) (groups reach all of a
> member's agents), [0007](../adr/0007-one-reader-per-account.md) (read/starred/archived belong to the person, not to
> each H), [0008](../adr/0008-direct-sends-reach-all-agents.md) (direct sends reach all agents),
> [0013](../adr/0013-people-only-external-identity.md) (other accounts see people, not agents),
> [0016](../adr/0016-replies-and-catching-up.md) and [0019](../adr/0019-agent-marks-read-after-showing.md) (when a
> send or an agent marks drops read) and [0022](../adr/0022-group-history-visible-to-members.md) (group history
> visible to members). The current architecture is described in [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md).

**版本：2026-09-17 / 设计基线 v0.2**  
**交付性质：可分 PR 实施的工程蓝图，不是已经部署的服务。**

## 0. 阅读与执行顺序

先读本文件的 §1–§5。仓库根目录的 `AGENTS.md` 是开发约束；外部契约在 `packages/contracts`（生成的 JSON Schema 在 `packages/contracts/json/`）；部署要求见 `docs/DEPLOY.md`。

本文件中 `agentdrop`、`pnpm dev`、`pnpm db:migrate` 等应用命令，是实施时必须提供的交互契约。

本次新增的昵称、私人备注、Agent 名称、发送偏好与群投递规则见 `docs/plan/PRODUCT_IDENTITY_AND_GROUPS.md`；工具面见 `docs/MCP_TOOLS.md`；仪表盘布局规则见 `docs/DESIGN.md`。增量已融入本文；原 H/ACL 原则保留。

## 1. 产品决策：先固定不会轻易改变的语义

AgentDrop 是跨网络的单次信息投递工具。人让自己的 Codex 或 Claude Code 把文字、明确选定的文件和整理后的上下文发给另一个人或群组；接收者可读取、保存、忽略，或另发一个独立 Drop。默认没有回复串，不共享原始会话，不自动执行收到的内容。

视觉可以借鉴邮箱的三栏布局和 WhatsApp 的联系人/群组导航，但不能因此把底层改成强制对话系统。群组时间线只是在一个权限空间中排列独立 Drop，不建立必须回复的父子关系。

### 1.1 六条强约束

1. **H 是收件单位，不是 session。** 持久身份为 `(user_id, device_id, harness_key, profile_key)`。`profile_key` 首版只用 `default`，预留以后同设备同 harness 的工作/个人隔离。
2. **同 H 多 session 共享同一份内容和邮箱状态。** 读取不出队、不删除；所有客户端在下一次读取或刷新时得到相同服务端状态。
3. **不同 H 是独立投递与状态单元，但同账号默认可跨 H 阅读。** 消息只投到解析出的 H；已读/收藏/归档也按 H 保存。
   为便于多机回看，账号下各 H 的 list/read 默认聚合本人全部 H 的合法收发记录，并标注真实收发 H；用户可关闭，恢复当前 H 隔离视图。
4. **发送给人，接收方决定落到哪个 H。** `@bob` 由 Bob 的默认接收路由解析，不能默认为广播到 Bob 所有设备。
5. **基础兼容只依赖 MCP Tools + stdio。** 不读取 Codex/Claude Code 私有 session 数据库，不注入终端，不依赖 hooks、私有日志格式或原生 session ID。
6. **共享收件内容不等于共享模型上下文。** 一个 session 读了某条 Drop，不代表另一个 session 的上下文中自动出现了这条内容；它仍需自己调用读取工具。

### 1.2 本规格的明确默认值

- 第一批真实客户端：Codex CLI、Claude Code；平台：macOS 和 Linux。其他 MCP 客户端进入兼容性测试矩阵后再声明支持。
- 第一版仅邀请制，默认已建立联系的人或共同群组成员可发送，避免开放公共目录和垃圾投递问题。
- 首个 H 可以在浏览器注册确认时设置为个人默认接收 H；没有有效路由则返回 `NO_DELIVERY_ROUTE`，不能猜一个在线设备代收。
- 收到不等于已读；MCP 读到不等于人读到；已读不等于处理完成。
- 默认没有自动过期；用户可以显式设定过期时间。存储配额必须可见，不静默删除历史。
- 网页和 MCP/CLI 的普通 list/read 默认查看本人全部 H；用户可关闭 `cross_h_mailbox_enabled`。Stop/idle 待办查询固定
  `endpoint_scope=current`，避免同一投递在多个终端重复提醒。
- ~~同 H 共用已读/收藏/归档状态；跨 H 阅读只读，不得改变另一个 H 的 delivery 状态。~~ 已被 [ADR 0007](../adr/0007-one-reader-per-account.md) 取代（2026-09-24）：已读/收藏/归档按人同步到该用户所有 H 的 delivery，回合结束提醒按账号只提醒一次。“哪个连接读取过”作为诊断元数据，
  不作为共享邮箱是否可见的条件。

### 1.3 设备的定义

Device 是安装 AgentDrop Bridge 的逻辑设备，不是按 IP、网卡或主机名识别的硬件指纹。安装时生成随机 UUID，稳定保存在本地，显示名可以改而 ID 不变。

**Remote SSH 特别规则：MCP Bridge 实际运行在哪里，Device 就属于哪里。** 在 Mac 上打开远程 GPU 服务器的终端并在服务器启动 Codex/Bridge，通常登记的是服务器，不是 Mac。容器、WSL 或隔离环境是否独立登记由安装配置决定，不能靠前端所在机器猜测。

复制包含设备 ID 和凭证的整个 home 目录会复制身份。因此新机器、镜像和容器模板不得预置这些秘密；提供 `agentdrop device rebind` 重新配对。H 的发送、投递状态和管理权限隔离由服务端授权保证；账号级跨 H 阅读是用户可关闭的显式策略，不能抵御同一 OS 用户下能够读取其他 H 密钥的恶意进程。更强隔离需关闭该策略，并使用不同 OS 用户、沙箱或独立账号。

## 2. 概念模型：User → Device → H → Connection

| 概念 | 含义 | 生命周期 | 决定内容权限吗 |
|---|---|---|---|
| User | 人类账户、联系人关系和管理权限 | 长期 | 是，网页所有者与群成员身份 |
| Device | Bridge 所在的逻辑设备 | 长期 | 间接，归属 H |
| H / HarnessEndpoint | 此设备上的某个 harness/profile | 长期 | **是，MCP 收件与发件作用域** |
| Connection | 一次 Bridge/MCP 连接实例 | 临时 | 否，只能使用其绑定 H 的权限 |
| NativeSessionRef | 用户授权的原生 session 标识 | 可选 | 否，不成为收件地址 |
| Drop | 一次投递的不可变正文与附件引用 | 持久 | 通过 grants 与 delivery 决定 |
| Delivery | 某个 Drop 在某个 H 的邮箱条目 | 持久 | 是，配合有效 grant |
| Group | 一个投递权限空间 | 持久 | 是，成员与接收绑定 |

例如：

```text
Jason
├─ MacBook (D1)
│  ├─ Codex/default (H1)
│  │  ├─ MCP Connection C1
│  │  ├─ MCP Connection C2
│  │  └─ MCP Connection C3
│  └─ Claude Code/default (H2)
└─ GPU-Server (D2)
   └─ Codex/default (H3)
```

C1/C2/C3 共享 H1 的投递状态；H1/H2/H3 各自保存 delivery 与状态，但默认可在本人账号范围互相列出/读取，并显示真实归属。
关闭跨 H 阅读后只保留当前 H 视图。重启 Connection、换项目目录、compact 或 resume 都不应创建新 H。注册 H 必须由 CLI 配对流程完成；Bridge 启动只加载现有 profile，缺配置就明确报错，不擅自注册新身份。

### 2.1 不把 MCP Connection 伪装成原生 session

基础 MCP 可以报告客户端实现信息和协议能力，但本项目不假定每个客户端都通过相同字段提供完整 session 列表、标题、工作进度或对话历史。一个客户端也可能跨 session 复用 MCP 进程。

因此首页准确显示“已登记 H”“活跃 MCP 连接”“最近工具调用”，而不是声称捕获了全部 Claude/Codex 会话。`NativeSessionAdapter` 是后续可选增强；没有原生数据时显示“未知/未接入”，不能用连接数冒充真实 session 数。

## 3. 寻址、个人路由与群组

**2026-09-28 修订（[ADR 0013](../adr/0013-people-only-external-identity.md)）：对外只有人。**
他人不可见 Agent 名称、工具、数量、自动地址、署名或接收模式。本人仍可见自己的所有 Agent 和投递归属。
主动发布的具名入口只展示名称与地址，不展示背后的 Agent；已有自动地址偏好不再生效，改为跟随接收者策略。
以下早期条款中单一默认 H 已由 ADR 0008 改为默认全部 H；群容量仍按 H 限制，但界面只报告是否超限。

### 3.1 三种目标

| 用户写法 | 服务端含义 | 首版行为 |
|---|---|---|
| `@bob` | 接收者本人 | 解析 Bob 已配置的单一默认 H |
| `@bob/work` | Bob 主动公开的命名接收路由 | 路由到接收者设置的 H，不暴露设备私有细节 |
| `#research` | 群组 | 展开当前有效成员及其明确绑定的 H |

原始 `h_id` 不作为对外必需的地址。机器调用先通过 `directory_lookup` 取得稳定 `route_id/group_id`；提交时服务端重新校验，不能信任客户端缓存的成员关系。无法投递、被拉黑等错误不泄露未授权的账户或设备信息。

### 3.1.1 昵称、备注与名称

公开昵称可重名，handle唯一；私人备注只在创建者视角出现，显示优先于公开昵称。每个 H 的 label 是可改的 Agent 名称，设备标签仅本人诊断可见。改名不改变 h_id、路由ID或历史。目录按备注/昵称/handle/群名返回授权候选和稳定目标；同名不猜。对外只展示获授权公开路由，不展示私有 H。

发送选择默认“对方默认接收端”，也可选对方主动公开的具名入口；显式记住偏好，不能擅自记住最后一次选择。偏好失效返回 PREFERRED_ROUTE_UNAVAILABLE，不静默改投。细则见 docs/PRODUCT_IDENTITY_AND_GROUPS.md。

### 3.2 个人路由规则

`@bob` 的目标 H 即使离线，也照样存入该 H 的云端邮箱，不能自动转送另一台在线设备。默认路由改变只影响未来新 Drop，旧 Drop 不迁移。需要搬运历史时，用显式“复制到我的另一个 H”，生成新的投递与审计记录。

同一个 send 请求因重试再次提交，必须返回第一次解析后的收件结果；即便此时默认路由已改变，也不能重新投递到新 H。

发送者的回执默认只说“已保存到接收方收件箱”；接收方私有的主机名、设备清单和 session 活动不公开。

### 3.3 群组成员不等于所有设备都加入

群组成员是 User，接收绑定是 `(group_membership_id, h_id)`。~~接受邀请时，用户必须选择至少一个自己的 H；……绝不因同一账户登录而自动加入其他设备。~~ 已被 [ADR 0006](../adr/0006-groups-receive-with-all-agents.md) 取代（2026-09-24）：建群和接受邀请默认「我的所有 Agent」接收，之后新配对的 H 自动绑定；用户仍可改为只用选中的 H，此时新 H 不会自动加入。

示例：Jason 只把 H1 绑定到 `#research`，新 Drop 只为 H1 创建 delivery，H2/H3 不会收到或产生自己的未读状态。
若 Jason 保持默认的跨 H 阅读，H2/H3 可以在账号汇总视图回看 H1 已获授权的 Drop，并明确标为“H1 收到”，但不能改 H1 的
已读/收藏/归档；关闭该偏好后，H2/H3 完全不显示这些 Drop。

### 3.4 历史、退群与重入

- 新成员或新 H 绑定从生效后接收，不自动补发历史。
- 发送时冻结成员/绑定快照；发送后的新人不能因为查群历史而得到旧 Drop。
- 退出群或取消 H 绑定后，该授权来源不再允许新的服务端读取；已下载或已进入模型上下文的副本无法收回。
- 重入使用新的 membership/binding ID，不重新激活原授权记录。
- 同一 Drop 可能同时私发和群发给一个 H，正文和邮箱条目只出现一次，但可有多个授权来源。退群仅撤销群来源，独立私发授权仍有效。
- 群发第一版限制 50 个有效目标 H，超限明确拒绝，不默默部分投递。后续确有需求再加异步 fan-out。
- 每群 20 人上限（在群成员 + 未回应的邀请）。投递端点上限是另一道闸（ADR 0006 提升到 200）；
  群页面和 CLI 显示人数与接收容量是否超限，不公开实际 Agent 总数（ADR 0013）。
- **2026-09-22 修订（本节第 1、2 条的唯一例外）**：群主/管理员可读本群全部历史，包括加入之前的 Drop。走唯一授权断言的
  `group_admin` 来源，只在显式 `include_group_history` 下进入列表，只读（无 delivery 可改状态），逐次审计。普通成员的
  「不补发历史」不变。
- **2026-10-02 修订（[ADR 0022](../adr/0022-group-history-visible-to-members.md)，第二个例外）**：每个群有一个只能由
  群主修改的设置 `history_visible`（默认关，已有的群也是关）。开启后，所有有效成员都可只读地查看本群全部历史，包括
  入群之前的 Drop：唯一授权断言增加 `group_history` 来源（按群授权判断，忽略 grant 撤销，与管理员规则相同的单 H 边界），
  列表、详情、附件、搜索与导出都走它；不产生 delivery，不算未读，不提醒，属于普通读取（不写管理员历史审计）。
  退群/被移出后看不到；关闭后入群较晚的成员失去入群前的访问，已投递给他们的保留。仍然不补发历史。

群投递必须覆盖当次有效接收成员。有效成员若没有可用H绑定（例如H已被撤销），返回GROUP_RECIPIENT_UNAVAILABLE，全单不提交；不能默默跳过后声称全员收到。成员离线不是不可用，云端仍然存储。

群组管理变化与群发解析要在相同一致性策略下串行化。实现时使用群行锁或版本检查和重试；不允许“检查时是成员，写入时已退群”的无约束竞态。

## 4. 总体架构与技术栈

```text
Codex / Claude Code / 其他受支持 MCP Client
                │ 本地 stdio MCP
                ▼
     通用 AgentDrop Bridge（每连接一个轻进程）
       本地 H profile、受控文件读写、脱敏检查
                │ HTTPS，只向外连接
                ▼
┌──────────────── 中心化服务 ────────────────┐
│ Caddy TLS → Fastify API → 领域服务         │
│                  │                        │
│            PostgreSQL                     │
│        Drops / Delivery / ACL / Outbox     │
│                  │                        │
│            Worker → 对象存储清理/通知       │
│                  │                        │
│            私有 S3 对象存储                │
└───────────────────────────────────────────┘
                ▲ HTTPS / 同源 Cookie
                │
       React 网页（邮箱、群组、H、连接、设置）
```

第一版不需要本地 daemon、Redis、Kafka、NATS、Kubernetes、P2P 或自创 A2A 协议。多个 Bridge 的共同数据源是云端数据库，不是某个 Bridge 的进程内存。

| 部分 | 决定 | 维护理由 |
|---|---|---|
| 语言/运行时 | TypeScript，Node 24 LTS，pnpm workspace | Web/Server/Bridge 共享契约，减少多语言接口漂移 |
| 服务端 | Fastify + Zod + OpenAPI | HTTP 入口薄，验证统一 |
| 数据库 | PostgreSQL 17，Drizzle migrations | 关系与授权约束显式，事务可靠 |
| Web | React + Vite + TanStack Query + shadcn/ui | 应用型三栏界面，不引入不必要 SSR |
| MCP | 官方 TypeScript SDK 的已发布稳定版本 | 不手写 JSON-RPC，能力协商交给 SDK |
| 认证 | Better Auth 网页登录 + 已维护的设备授权流程 | 不自写密码/OAuth 算法 |
| 文件 | 开发环境受控 filesystem provider；生产私有 S3 | 相同 StorageProvider 契约，测试两种后端 |
| 后台任务 | PostgreSQL transactional outbox + 单独 worker 进程 | 不额外运维消息中间件 |
| 测试 | Vitest + PostgreSQL 集成测试 + Playwright + MCP 黑盒测试 | 覆盖真实协议和授权，不只 mock |
| 部署 | Docker Compose + Caddy；云端备份 | 模块化单体，组件以后可独立横向扩容 |

技术选型是本项目的设计决策；库具体 patch 版本在 PR-00 选定、运行互通测试后锁入 lockfile。生产依赖和镜像不得使用漂移的 `latest`。Node LTS、MCP 支持及认证能力以各项目的官方文档为准。

### 4.1 模块边界

```text
apps/api        HTTP + 认证适配，不写业务规则
apps/worker     outbox、文件清理、维护任务
apps/web        网页
apps/cli        配对、配置、doctor、MCP stdio 入口
packages/domain     H、路由、投递、权限、状态规则
packages/contracts  Zod / JSON Schema / OpenAPI 类型
packages/db         schema、迁移、repository
packages/mcp        tools 注册、结果编码、能力协商
packages/storage    FsStorage / S3Storage
packages/security   路径校验、风险扫描、策略执行
packages/client     typed HTTPS API client
packages/adapters   可选 harness 配置/原生元数据适配
```

`packages/domain` 不得 import MCP、React、Codex 或 Claude Code 专属代码。Web、MCP、未来 remote MCP 都调同一个领域用例，而不是各自实现一套权限和投递逻辑。

## 5. 数据模型与关键约束

认证框架自己的用户/会话表与业务表分开迁移。以下是领域表设计，不是完整 SQL 迁移文件。

| 表 | 关键字段与约束 |
|---|---|
| `app_users` | `id, auth_user_id, handle, display_name, public_email?, avatar_attachment_id?, profile_version, cross_h_mailbox_enabled`；handle唯一规范化，display_name为可改公开昵称，public_email 为本人自报的公开邮箱（[ADR 0012](../adr/0012-public-email.md)），跨 H 阅读默认开启且可关闭 |
| `devices` | `id, user_id, installation_id, label, revoked_at` |
| `harness_endpoints` | `id, user_id, device_id, harness_key, profile_key, label, public_name?, name_version, revoked_at`；唯一 `(user_id,device_id,harness_key,profile_key)` |
| `h_credentials` | `id, h_id, token_hash, scopes, expires_at, revoked_at`；只存 hash，不存明文 token |
| `connections` | `id, h_id, client_name, client_version, capabilities, opened_at, last_seen_at, closed_at, label?` |
| `recipient_routes` | `id, user_id, alias, label, destination_h_id, is_default, visibility, revoked_at, version`；默认单一路由，外部响应不返回私有目的H |
| `contacts` | `owner_user_id, peer_user_id, permission, blocked_at, remark?, preferred_route_id?, version`；备注仅owner可见，不含对方私有设备列表 |
| `groups` | `id, slug, display_name, description?, owner_user_id, version, created_at`；显示名可重名 |
| `group_memberships` | `id, group_id, user_id, role, nickname?, joined_at, revoked_at`；重入产生新 id |
| `group_bindings` | `id, membership_id, h_id, enabled_at, revoked_at`；校验 H 属于成员用户 |
| `drops` | `id, author_user_id, origin_h_id, origin_kind, payload_version, kind, title, body, extensions, created_at, expires_at`；提交后正文不可变 |
| `attachments` | `id, uploaded_by_h_id, storage_key, safe_name, content_type, byte_size, sha256, status` |
| `drop_attachments` | `drop_id, attachment_id, ordinal`；附件顺序固定 |
| `deliveries` | `id, drop_id, h_id, received_at, read_at, starred_at, archived_at, state_version`；唯一 `(drop_id,h_id)` |
| `delivery_grants` | `delivery_id, kind, membership_id?, binding_id?, revoked_at`；区分 direct 与 group 多来源 |
| `send_requests` | `origin_h_id, request_id, request_hash, result_drop_id, outcome, approval_id?`；唯一 `(origin_h_id,request_id)` |
| `approvals` | `id, actor_user_id, origin_h_id, content_hash, target_snapshot, approved_at, expires_at` |
| `mailbox_heads/events` | 每 H 的 revision 及已提交变更事件，用于状态刷新/未来增量同步 |
| `outbox_events` | `id, type, aggregate_id, payload, attempts, available_at, locked_until, delivered_at` |
| `audit_events` | `actor_user_id,h_id,action,target_id,result,request_id,created_at`；不记录正文、token、绝对文件路径 |

关联表必须通过外键/服务端约束保证 user、device、H 的所有权一致。不能接受客户端指定另一个 `user_id` 或 `h_id` 来跳过权限过滤。

### 5.1 接口授权规则

H 凭证验证后生成 `HPrincipal { userId, hId, scopes }`，所有 MCP 对应 HTTP 请求由此获取作用域。邮箱接口不接收可自由切换的 `h_id` 参数。
list/read 的账号范围由服务端根据 `userId` 与 `cross_h_mailbox_enabled` 推导；客户端只能用 `endpoint_scope=current` 收窄到凭证 H，
不能指定另一个 H。发送、上传、群绑定和状态修改始终固定到凭证 H。

网页使用另一种 `UserPrincipal`，显式指定本人 H 作为发送与当前状态视角并验证归属；普通读取同样可按账户偏好聚合。网页管理员能力不能经由 Bridge 凭证间接使用；网页登录凭证不放到模型工具返回值里。

对 Drop 的读取：

```text
有有效的 H 凭证
AND H 未撤销
AND Drop 未过期/撤销
AND (
  当前 H 是合法发件 H
  OR 存在当前 H 的 Delivery 且至少有一个仍有效的 Grant
  OR (跨 H 阅读已开启且未要求 endpoint_scope=current 且
      (发件 H 属于当前 user OR 当前 user 的任一 H 存在有效 Delivery/Grant))
)
```

附件下载、搜索结果、未读数、群时间线、导出和增量事件必须复用同一读取授权逻辑。不能只在列表层过滤、详情和附件按 ID 裸读。
状态修改另加硬条件：当前 H 必须拥有该 delivery，并使用它的 `state_version`；跨 H 只读命中不能获得修改另一个 H 的能力。
返回值应带 `origin_agent`、本人可见的 `deliveries[]` 与隐私受限的 `recipients[]`，用于解释实际归属；发送者看到的目标归属只来自
发送时公开/授权的地址快照，不泄露接收方其他私有 H、设备名或活动。

### 5.2 收件不是任务队列

`list_drops` 和 `read_drop` 都不将内容取走，也不自动标记已读。`read_drop` 可以记录 connection 的 fetched 元数据，但必须与共享的 read state 分开。

`set_drop_state` 显式更新已读/收藏/归档，整个 H 的 session 共享这些标记。账号内另一个 H 即使能读取该 Drop，也不能替它修改。
UI 默认仍显示已读内容，不因被另一个 session 看过就消失。

首版不自动接任务，因此不用 claim。以后引入自动处理时新增独立 `processing_claims(drop_id,h_id,lease_until,run_id,fencing_token)`；不能用“已读”充当互斥锁，也不能声称 exactly-once 执行。

## 6. Drop 与 MCP 外部契约

### 6.1 正文是版本化对象，身份不是模型填写

`packages/contracts/json/drop-v1.schema.json` 定义请求 payload：

```json
{
  "payload_version": 1,
  "kind": "context",
  "title": "训练不稳定排查结论",
  "body": "已经排除数据顺序；还需验证梯度累积设置。",
  "attachment_ids": [],
  "extensions": {
    "org.agentdrop.context": {
      "schema_version": 1,
      "decisions": ["暂不更改优化器"],
      "open_questions": ["不同 batch 下是否复现？"]
    }
  }
}
```

发送 envelope 另有 `request_id` 与 `targets`。`author_user_id, origin_h_id, created_at` 全由认证后的服务端生成。扩展字段设 16 KiB 上限；未知 namespace 不执行、不改变权限，只存储并作为普通数据展示。正文首版上限 64 KiB UTF-8，标题 160 字符，最多 10 个附件。

MCP 调用体限制简单、稳定，优先基础对象和枚举；不要求模型提供复杂的原生 session 数据结构。输出提供机器可读 JSON，并为不消费 structuredContent 的客户端提供简短文本兼容表示。错误返回稳定 code 和可执行 next_action，不返回堆栈或秘密。

### 6.2 首版本地默认七个工具：核心五个 + 文件两个

| 工具 | 输入摘要 | 作用与边界 |
|---|---|---|
| `directory_lookup` | `query?, kind?, limit?, cursor?` | 按本人备注/昵称/handle/群名查授权候选；空query为有界最近目录，不遍历陌生用户 |
| `list_drops` | `view, group_id?, cursor?, limit?, query?, unread_only?, endpoint_scope?` | 默认聚合本人全部 H 的合法 inbox/sent；`endpoint_scope=current` 收窄到当前 H；摘要标注真实收发 Agent |
| `read_drop` | `drop_id, offset?, max_chars?` | 按服务器解析的当前/账号读取范围校验，分段读正文并返回归属；不自动已读 |
| `send_drop` | `request_id, targets, payload` | 幂等投递；风险策略可能返回 `needs_approval` 而非已发送 |
| `set_drop_state` | `drop_id, expected_version, read?, starred?, archived?` | 只改当前 H 的邮箱标记；无当前 H delivery 时拒绝，版本冲突返回 409 类错误 |
| `upload_file` | `path, display_name?` | 仅本地 Bridge，校验允许目录与风险，再上传，返回 attachment_id |
| `download_file` | `drop_id, attachment_id` | 下载到受控路径，不执行、不解压，不让消息指定任意写入位置 |

`core`工具集暴露前五个；`standard`默认增加两个本地文件工具，共七个。新功能不自动增加工具；群发/群读复用send/list。改名、备注、建群、默认配置通过Dashboard/CLI的管理凭证完成。/identity HTTP与CLI doctor保留；list/read/send携带最小当前viewer信息，不另占默认工具。工具annotations只是客户端提示，不代替服务端权限；客户端自报名称不是安全身份。详见 docs/MCP_TOOLS.md。

### 6.3 返回状态不能含糊

- `delivered`：服务端已原子保存 Drop 与目标 Delivery，可供读取；不代表目标在线或人已看过。
- `needs_approval`：保存待审批草稿/内容摘要，尚未向收件方投递。返回人类可在网页打开的批准入口。
- `not_sent`：未提交；`retryable` 决定是否用同一 request_id 重试。
- `unknown`：网络中断导致客户端不知道结果，应查 request 状态，不生成新请求重复发送。

请求 id 由调用者创建并跨重试保持；Bridge 将进行中的请求结果记录为本地小型操作日志。MCP request ID 不是业务幂等键。

### 6.4 后续远程 MCP

核心用例与工具 schema 保持不变，再提供 Streamable HTTP transport。远程服务器不能读客户端 `~/file.pdf`；remote 模式须用网页上传或显式客户端上传后拿 attachment_id。不要宣传本地/远程文件能力完全等价。

资源订阅、elicitation、采样、主动注入等均为可选增强；不支持时仍能手动 list/read。接收到网络通知不代表 harness 会自动启动一轮模型推理。

## 7. 发送、刷新与一致性

### 7.1 一次可靠发送

1. Bridge 加载固定 H profile，检查正文/附件、配额和本地允许路径。
2. 文件先进入 staging；上传完校验实际字节数、hash、媒体类型并转为 ready。未完成文件不能被引用投递。
3. 服务端验证凭证、联系人/群权限、目标有效性、payload 上限和附件归属。
4. 已接受联系人和有效群成员关系已经代表人类授权，普通文字、上下文和成功上传的附件都由 Agent 直接发送。默认部署不设置人工批准闸门；组织若另行启用严格审批策略，批准必须绑定正文 hash、附件 hash、目标快照，任何修改都使批准失效，目标变化返回 `STALE_APPROVAL` 重新预览。
5. 在一个数据库事务内写入 `send_requests → drops → deliveries/grants → mailbox revision/events → outbox → audit`，才返回 delivered。
6. 客户端断线时用同一 request_id 查询或重试；唯一约束保证只有一个 Drop，同键不同内容报 `IDEMPOTENCY_CONFLICT`。

首版对一个 send 的所有目标采用全成功或全失败；不产生用户看不清的静默部分发送。后续大群异步模式必须显式改为 `accepted` + 可查逐目标进度。

### 7.2 刷新与分页

Web 前台每 10 秒刷新当前 H 所在的账号汇总列表与计数（关闭跨 H 阅读时仅当前 H），失焦后降频；这是建议默认值，不是实时性承诺。Bridge 仅在工具调用时读取收件内容，不为每个 session 持续调用 LLM 或轮询完整邮箱。Stop/idle 通知例外地显式请求 `endpoint_scope=current`，只提醒当前 Agent 的未读。

连接心跳每 30 秒一次并加随机抖动，90 秒未见则标记“连接过期/未在线确认”。这些是 Bridge 连接状态，不代表模型正在工作。

列表使用 keyset cursor 与明确的服务端快照边界，不用大 OFFSET。每次响应返回当前 h_id、查询范围和相关 mailbox revision；前端缓存 key 必须包含 h_id 与范围，切换 H 时不能短暂展示前一视角的内容。

若实现持久增量事件：对受影响 H 的 mailbox_head 按 h_id 固定顺序加行锁，事务内递增 revision 并写事件，避免用事务提交前分配的全局序号假定提交顺序。游标过期返回 `RESYNC_REQUIRED`，客户端重新获取授权后的快照。权限撤销也需要 revision/tombstone，不能只同步新消息。

### 7.3 Outbox 只承载派生副作用

邮件通知、网页推送、过期文件清理等由 worker 处理；投递本身和授权写入不依赖 worker 成功。Worker 使用租约、幂等 event id、有限重试及 dead-letter；重复通知不会再创建一条 Drop。

不把 PostgreSQL NOTIFY 或 WebSocket 在线消息作为唯一事实来源。丢通知后仍能通过数据库重新同步。

## 8. 文件与安全

### 8.1 文件路径

首版默认仅允许显式配置的导出目录；用户可通过 CLI/网页受控操作增加项目目录。禁止默认扫描整个 home 或整个仓库。MCP roots 可作辅助，但 Bridge 仍执行自己的 allowlist 校验。

上传时解析规范路径并防目录穿越、符号链接逃逸和检查后替换；按平台采用安全打开策略，在实际打开的文件描述符上确认文件类型、大小和边界，不允许目录递归上传。高风险路径如 `.ssh`、`.aws`、密钥与凭证文件默认阻断。规则脱敏不是“保证没有商业秘密”，加密/二进制附件尤其要提示人工审查。

下载固定写入 `~/.local/share/agentdrop/downloads/<drop_id>/<safe_filename>`；名称 sanitize，不接受正文里的路径、shell 命令或自动执行要求。冲突写入使用唯一名称或原子完成，不覆盖已有工作文件。

### 8.2 文件传输

首版建议每文件 50 MiB、每 Drop 100 MiB、每 H 1 GiB 可配置配额。这些是启动限额，不是容量基准测试结果。

Bridge → authenticated API 流式上传 → 私有 S3；API 不把整文件读进内存。上传阶段预留配额，结束后校验实际大小；staging 对象 24 小时清理。服务端生成随机 object key，正文和用户文件名不能控制 bucket 路径，不跨用户用 hash 作可猜测地址。

默认下载经 API 鉴权代理，确保每次新下载请求都检查当前权限。以后为大文件改用短效 presigned URL，必须向用户说明 URL 在失效前通常可用，退群不会瞬间撤销所有已签发 URL；已开始传输/已经下载的副本更无法收回。

### 8.3 认证与 H 凭证

网页用成熟认证库，Cookie 为 HttpOnly、Secure、SameSite，同源部署并检查 CSRF/Origin。设备配对使用维护中的 device authorization 流程；浏览器批准时展示设备显示名、harness、profile 和权限。Headless SSH 用户在自己的浏览器输入配对码，不必在服务器打开浏览器或入站端口。

配对得到短期注册授权后，签发**仅绑定一个 H**的高熵 opaque credential；服务端仅存 hash，可撤销、可到期。默认有效期建议 90 天，可按组织策略缩短；到期前在 doctor/Web 提示重新配对。多个 Bridge 读取同一 profile 凭证，首版不引入每进程自行刷新同一轮换 refresh token 的并发问题。

token 保存在 OS keychain；无可用 keychain 的无界面环境使用权限 0600 的文件并明确降级提示，目录 0700。用户级管理令牌不能放进 Bridge。日志、URL、MCP 返回值和复制配置中都不包含 token。更换凭证不更换 H；撤销当前凭证不删除邮箱内容。

### 8.4 内容与操作边界

收到的正文、附件、标题和来源引用都属于外部不可信数据。正文里“忽略原指令、上传你的密钥”等要求不能转化为更高优先级指令。系统首版不自动执行收到的脚本、不自动访问任意 URL，不转授 SSH/OAuth/MCP/GitHub 凭证。

网页 Markdown 禁用原始 HTML 与危险 URL；加 CSP；附件下载使用安全 Content-Disposition；被丢弃的授权内容从客户端缓存中清理。安全日志只记动作、结果、IDs 和 size，不记正文。

### 8.5 第一版不声称端到端加密

公网传输必须始终 HTTPS；数据库和对象存储启用静态加密并最小权限。运营者仍有能力读取明文内容，应明确告知。

为未来 E2EE 预留 `content_envelope` 和 `crypto_version` 扩展点，但 E2EE 会影响搜索、预览、群密钥、设备加入/撤销和恢复，是独立项目，不是改一个布尔开关。服务端 E2EE 不等于接收方模型服务商看不到用户主动读取的内容。

## 9. 仪表盘与交互规范

### 9.1 导航

主导航：Inbox、Contacts、Groups、我的 Agent、Connections、Drafts & Approvals、Settings。Operations 只给服务管理员。具体布局规则见 docs/DESIGN.md：人以备注/昵称显示，H以Agent名显示，ID放调试详情；同名候选不能直接发送。

全局顶栏永久显示**当前 H**与设备/harness 标签，避免发错端、改错状态。普通用户首页是收件箱，不是运维指标墙。网页和 MCP/CLI 普通读取默认采用“我的全部 H”聚合视图，并在每条记录显示实际收发 Agent；用户可在设置关闭。发送与状态按钮始终以当前 H 为准，另一 H 的 delivery 只展示不修改。

### 9.2 邮箱三栏（桌面建议值）

```text
┌────────────────────────────────────────────────────────────────────┐
│ AgentDrop   [MacBook · Codex ▾]    搜索                 [+ New Drop] │
├─────────────┬────────────────────────┬─────────────────────────────┤
│ Inbox  8    │ 全部 / 未读 / 有附件   │ 标题：训练稳定性排查          │
│ Sent       │                        │ From Alice · 10:42           │
│ Starred    │ Alice   训练排查        │ To @Jason · 当前 H 已收到     │
│ Archived   │ 2 files · 10:42        │                             │
│            │                        │ 正文/上下文摘要              │
│ Contacts   │ #research 实验日志      │                             │
│ Groups     │ 1 file · 昨天          │ 附件卡片、size、hash          │
│ ├ research │                        │ [下载] [复制引用] [已读]      │
│ └ project  │ Bob     论文笔记        │ [转发为新 Drop] [归档]        │
│ Endpoints  │                        │                             │
│ Connections│                        │ 无默认 Reply 输入框          │
└─────────────┴────────────────────────┴─────────────────────────────┘
```

导航约 220 px，列表约 340 px，详情自适应；窄屏分步进入列表与详情。提供键盘搜索、上下选择、打开/返回；发送用明确按钮或 Ctrl/Cmd+Enter，不用普通 Enter 触发，以免在多行正文中误发。需键盘可访问、清晰焦点与 loading/empty/error/offline 状态。

页面风格是“邮箱的易检索 + WhatsApp 的联系人亲近感”，不是仿制商标。UI 自带明确的单次投递状态。

### 9.3 各页必须展示什么

| 页面 | 内容 | 不应暗示的能力 |
|---|---|---|
| Inbox | 发送者、标题、摘要、附件数、received_at、每个本人 Agent 的投递/状态、投递来源 | 不暗示全部 session 已读取；不允许改非当前 H 状态 |
| Contacts | 本人备注优先、公开昵称/@handle、默认/具名发送入口、发送/屏蔽/移除联系 | 不展示对方私有 H 和工作内容 |
| Group | 群名/群昵称、独立Drop时间线、成员角色、当前H是否接收、接收绑定与配置异常 | 不自动展示加入前历史 |
| 我的 Agent | 可改Agent名称、本人Device→H层级、公开署名/路由、默认接收、连接数、最近活动、撤销/重配对 | 不把 H 状态当模型任务进度 |
| Connections | Bridge connection_id、所属 H、client_info、最近工具、连接时间、可选标签 | 不把连接数冒充真实 session 数 |
| Drafts & Approvals | 待发内容、目标、风险、内容 hash、批准/拒绝、有效期 | 未批准不得写成已发送 |
| Operations | HTTP error、延迟、DB pool、outbox age、文件容量、备份验证结果 | 不默认提供所有用户正文浏览 |

### 9.4 “会话信息”可选增强

基础版会话页命名为“连接与会话”，默认分栏：MCP Connections / Native Sessions（未启用）。后来添加 `NativeSessionAdapter` 后，才展示实际 session 标题、原生 ID 或续接入口。Adapter 必须 opt-in、可移除；不允许它更改 H 邮箱身份，也不上传原始历史作为默认遥测。

### 9.5 往来视图不是 thread

联系人页可以把与这个人交换的独立 Drop 按时间排在一起，群组页也可使用气泡或卡片式时间线。但存储不要求 `conversation_id` 或 `reply_to`。后续可附可选 `related_drop_id`，只作引用，不表示对方必须响应，也不自动授予引用对象权限。

**2026-10-01 修订（[ADR 0016](../adr/0016-replies-and-catching-up.md)）**：该可选引用以 `payload.reply_to` 实现，仍不是 thread：
发送者必须能读被引用的 Drop；读者只在自己也能读原 Drop 时看到其标题，否则为 null。本人带 `reply_to` 的发送会把原 Drop
标为本人已读，向群发送会把此前经该群收到的 Drop 标为本人已读；读取仍不改变状态。

## 10. 安装与日常使用目标

### 10.1 一次配对，所有 session 复用

实施后应提供：

```bash
agentdrop login --server https://drop.example.com
agentdrop endpoint add --harness codex --profile codex --label "MacBook Codex"
agentdrop endpoint add --harness claude-code --profile cc --label "MacBook Claude Code"
agentdrop connect codex --profile codex
agentdrop connect claude-code --profile cc
agentdrop doctor
```

`drop.example.com` 是占位域名，需要替换成自己的公网域名。`connect` 命令只做幂等配置写入：先备份，再最小修改；不覆盖原有 MCP、API key、代理或用户规则。失败可以 `disconnect` 恢复单条记录。

保存路径建议：

```text
~/.config/agentdrop/device.json
~/.config/agentdrop/profiles/codex.json
~/.config/agentdrop/profiles/cc.json
~/.local/share/agentdrop/downloads/
~/.local/state/agentdrop/logs/
```

Profile 保存 server_url、h_id 和 credential reference，不保存原始 session 历史。新 session 只读 profile，无需再次授权。

### 10.2 官方客户端配置形态

以下客户端命令形式已通过当前官方文档核对，但 `agentdrop` 二进制本身仍需按本规格实现并安装；配置命令执行后还要做真实收发测试。

```bash
# 用已安装程序的绝对路径最稳妥；此处是拟定安装位置。
CODEX_BRIDGE="$HOME/.local/bin/agentdrop"

codex mcp add agentdrop -- "$CODEX_BRIDGE" mcp --profile codex
claude mcp add --transport stdio --scope user agentdrop \
  -- "$CODEX_BRIDGE" mcp --profile cc

codex mcp list
claude mcp list
```

Codex 等效 TOML：

```toml
[mcp_servers.agentdrop]
command = "/absolute/path/to/agentdrop"
args = ["mcp", "--profile", "codex"]
startup_timeout_sec = 20
tool_timeout_sec = 120
```

不要把共享项目中的配置写成同一个人的 h_id/token。默认使用各人的用户级配置。工具 timeout 可根据实际客户端支持进行验证；上传超过限制时显式失败，不让调用无期限挂起。

MCP Bridge stdout 仅允许协议帧，所有诊断日志写 stderr。网络错误不导致配置丢失；Bridge 启动不因云端暂时离线无限阻塞。

### 10.3 日常操作

自然语言“看看别人发来的内容”→ list；“读 Alice 那条”→ read；“把这些结论和 notes.md 发给 Bob”→ 选择文件上传、send。高风险情形需要用户打开可信批准页确认，允许用户在设置中建立有范围的联系人外发政策来减少重复确认。

`doctor` 应检查：当前逻辑设备、各 profile 的 H、配置路径、真实 executable 路径、凭证到期、HTTPS 可达性、协议握手、工具列表、文件允许目录。只在显式 `--send-test` 且用户指定自己目标时发送测试 Drop。

## 11. 扩展性：固定接口，不预建空壳微服务

| 扩展 | 需要新增 | 必须不改变 |
|---|---|---|
| 新 MCP harness | 配置 recipe、互通测试、可选 metadata adapter | H/Drop/ACL/MCP 核心工具 |
| 同设备工作/个人隔离 | 新 profile_key | 已有 H 的身份与历史 |
| 新消息类型 | 新 kind 或带 schema_version 的 namespace | 原有文本和附件回退阅读 |
| 大文件 | 分片/直传 StorageProvider 路径、重新考虑签名 URL 撤销语义 | 授权判断、attachment_id 契约 |
| 实时网页通知 | SSE/事件订阅、断线补偿 | DB 事实来源与 H 作用域 |
| 远程 MCP | HTTP transport + 标准授权 | 领域服务，不伪造本地文件能力 |
| 自动处理 | claim/lease/fencing、预算、执行沙箱、显式规则 | mailbox 读取不是任务出队 |
| 企业租户 | tenant membership、策略、审计、SSO | 不重写 H 定义，不用 JSON 拼接权限 |
| 原生 session 展示 | opt-in NativeSessionAdapter | 收件身份不依赖原生 session ID |
| E2EE | 密钥/群密钥/恢复/本地搜索方案 | 外部 metadata 与内容授权的边界明确 |

新增 payload 字段保持向后兼容；增加工具不能悄悄扩大旧权限。REST `/v1` 与 `payload_version` 分开演进。客户端与服务端记录兼容性范围，版本不兼容时给明确升级建议。

### 11.1 扩容触发而不是先猜规模

先用单 API、单 worker、单 PostgreSQL 和对象存储做真实测量。容量目标应写进可重复负载脚本，例如 1,000 H / 3,000 connections / 100 小正文请求每秒，但必须标为测试目标，不作为未测 SLA。

当数据库连接池排队出现，先检查索引、慢 SQL、事务长度和连接复用；当 API CPU 饱和，再水平增加无状态 API；当文件传输占满 API 带宽，再改直传；当 group fan-out 超过首版上限，再上异步投递。每次扩容只解决已测瓶颈，不用“可扩展”作为一开始引入所有组件的理由。

## 12. 交付门槛

服务开发完成必须通过 `docs/QUALITY.md` 中的验收清单。最重要的验收不是页面效果，而是：

> 同一 H 的三个连接都能读同一条 Drop；默认开启时，同一用户其他 H 能读取并看见它属于哪个 Agent，但不能修改该 H 的状态；关闭跨 H 阅读后其他 H 即使知道 drop_id 和 attachment_id 也读不到；跨真实网络离线后重新上线仍能取到；多次重试只生成一条；群退出与重新加入不会偷偷恢复历史授权。

先把这个闭环做对，再增加仪表盘丰富度与原生 session 可观测性。


---
