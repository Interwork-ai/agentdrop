# v0.2 产品身份、默认目标与群组规范

> **Historical baseline.** This is the v0.2 product rule set for names, default targets and groups. Later decisions
> changed parts of it: where this text and a record in [`docs/adr/`](../adr/README.md) disagree, the ADR wins. The
> main superseding records are [0006](../adr/0006-groups-receive-with-all-agents.md) (groups reach all of a member's
> agents), [0007](../adr/0007-one-reader-per-account.md) (read/starred/archived belong to the person),
> [0008](../adr/0008-direct-sends-reach-all-agents.md) (direct sends reach all agents),
> [0012](../adr/0012-public-email.md) (public email), [0013](../adr/0013-people-only-external-identity.md) (other
> accounts see people, not agents) and [0022](../adr/0022-group-history-visible-to-members.md) (group history visible
> to members).

这是提议实现的产品规则。这里所有姓名与对象都是示例，不是已连接的真实联系人。

**现行覆盖规则（2026-09-28，[ADR 0013](../adr/0013-people-only-external-identity.md)）：**
对外只展示人，不展示 Agent 的名称、工具、数量、自动地址和署名。本人仍可管理自己的 Agent。
主动公开的具名入口仅暴露入口名称与地址，不能暴露背后的 H。自动地址的历史偏好改为跟随接收者策略。
默认接收策略由 ADR 0008 规定为全部 Agent；群接收由 ADR 0006 规定，状态按 ADR 0007 归人共享。

## 1. 面向人的名字与机器身份必须分离

| 层 | 样例 | 谁能改 | 可见范围 | 是否路由键 |
|---|---|---|---|---|
| 公开昵称 app_users.display_name | 王同学 | 本人 | 获授权联系人/群成员 | 否，可重名 |
| 唯一 handle | @wang | 本人注册时选择 | 获授权目录 | 用于发现，内部仍用 user_id |
| 公开邮箱 app_users.public_email（[ADR 0012](../adr/0012-public-email.md)） | wang@example.org | 本人，仅网页会话 | 已接受且未屏蔽的联系人、同群有效成员、其 Drop 的接收者；本人所有 Agent 显示同一个 | 否，自报未验证，可在授权目录内搜索 |
| 私人备注 contacts.remark | 老王·实验合作 | 备注的创建者 | 仅创建者的网页和其 H 目录 | 否 |
| Agent 名称 harness_endpoints.label | 科研助手 | H 所有者 | 默认本人 | 否，h_id 不变 |
| 历史 Agent 署名 public_name | 科研助手 | 所有者 | 仅本人，外部返回 null（ADR 0013） | 否 |
| 具名接收路由 label / alias | 科研 / @wang/research | 接收者 | 主动发布给允许联系人 | 是稳定 route_id 的展示 |
| 群组名称 groups.display_name | 论文讨论组 | 群管理员 | 成员 | 否，可重名，使用 group_id |
| 群内我的名字 membership.nickname | 王同学·RL | 本人 | 该群成员 | 否 |
| 设备名 devices.label | 办公室服务器 | 本人 | 仅本人管理页 | 否 |

没有必要向普通用户展示 UUID。常规界面显示昵称/备注/Agent 名称；调试页可复制 ID。
第一版 handle 和 route alias 创建后不在线改名，昵称/备注/显示名可随时修改。以后支持 handle 改名要保留别名、设置保护期并避免旧名字马上被他人抢注；不是本次必做项。

### 1.1 展示与搜索规则

个人列表标题优先：**我的私人备注 > 对方当前昵称 > @handle**；始终有 @handle 作为副标题或确认卡标识。
群成员显示优先：**我的私人备注 > 该人的群昵称 > 公开昵称 > @handle**。
Agent 卡片：**Agent 名称**作为主标题；本人视角副标题“设备 · harness”。他人视角只能看该人主动公开的路由名称，不列私有 H。

目录搜索范围只含已有联系人、获授权的共同群成员、本人入口与已加入的群；不得开放陌生人穷举。query 可匹配本人备注、公开昵称、handle、获授权群名/群昵称、公开路由名。
空 query 只返回一个有界的最近联系人/群列表；不是列出全站用户。limit 默认 10，最大 20，分页有 cursor。
字符串统一做 Unicode 规范化、大小写与空白处理；展示值保留用户写法。首版不依赖拼音检索服务。

**同名不猜。** 同一查询匹配到两个人或两个群，返回候选卡和稳定 ID；Agent 必须让用户选。不能按“第一个搜索结果”发。群与人必须用不同类型徽标区分。
昵称、备注与群名也是不可信文本：禁 HTML/控制字符、转义展示、限制长度，不拼入系统指令。长得像某个组织管理员的昵称不授予该组织权限。

### 1.2 备注的隐私

备注是联系人创建者账户的私有元数据，可在他自己的 Codex/CC 各 H 搜索。服务端以 UserPrincipal 或 HPrincipal.userId 推导备注所有者，不能通过参数读取别人的备注。
**不写入 Drop 正文、对方看到的 sender card、群成员公共响应、邀请、普通审计日志或通知。** 工具返回给本人 Agent 的备注属于其授权上下文，产品不能保证用户随后手动复制出去的内容仍保密。
备注删除则回退昵称。对方改昵称不覆盖我的备注。备注只改变显示和查找，不改变 user_id、route_id 或历史投递。

### 1.3 Agent 名称与原生 session

MacBook/Codex 的 H1 可以叫“小码”；服务器/Claude Code 的 H2 可以叫“实验助理”。同 H 开三个 session，仍然都是同一个“小码”，共用收件箱。不同 H 可以同名，管理页用设备/harness 副标题区分。
改 Agent 名称只更新 label/name_revision，不生成 H、不移动消息、不修改 profile 路径、不重新配对。初始化 MCP instructions 可能在存量连接里过期，所以 list/read/send 返回当前 viewer 标签；姓名改变不需要重启客户端。文件专用响应不必重复无关目录内容。
外发只署名真实用户；历史 public_name 仅本人可见。不得把主机名、内部路径或完整 H 配置作为外发署名。

## 2. 默认发送目标到底由谁决定

有两种完全不同的“默认”：

- **我的默认接收 Agent**：本人配置 @me → 我的某个 H；决定别人发给我时去哪。
- **我给某联系人的默认发送入口**：通常“跟随对方默认”，也可以显式记住对方公开的 @peer/research。

联系人卡：

```text
老王·实验合作                       @wang
公开昵称：王同学

发送到：
● 对方默认接收端（推荐）
○ 科研入口                         @wang/research
○ 工作入口                         @wang/work

[ ] 将此次选择记为我给此联系人的默认入口
[发送]
```

第一次默认“跟随对方默认”，不是自动记住“上次偶然选的设备”。明确指定本次入口可覆盖已存偏好，但不静默改偏好。
偏好只指向接收方仍公开给我的 route_id，不能记录对方私有 h_id。若记住的入口被撤销/不再授权/不存在，返回 `PREFERRED_ROUTE_UNAVAILABLE`，提示选择；**绝不静默退回另一个默认入口**。
收件人可改变入口背后的 H，sender 的偏好仍指向该入口。改的是接收者路由，不是发送者越权选设备。

### 2.1 解析、批准与重试

1. directory_lookup 用昵称/备注找到联系人卡，返回默认/偏好目标与公开 alternatives。
2. 用户或 Agent 按明确目标选稳定 route_id/group_id。工具 schema 中发送不接收裸昵称。
3. send_drop 从可信身份确定发送者，重新校验目标授权；需批准时保存目标 ID/版本与内容 hash。
4. 正式提交冻结实际路由/群绑定。已批准后配置变化触发 STALE_APPROVAL，不静默扩大批准对象。
5. 同 request_id 重试返回第一次投递结果；不能因为对方改默认 H 而再发一次。

显示名称可变化；授权与幂等都绑定稳定 ID。历史保存 author_user_id 和必要公开署名快照，当前展示可叠加查看者自己的新备注。历史不通过名字重新解析收件人。

## 3. 群组：一次投递给多个独立收件箱

```text
群：论文讨论组
  ├─ 我     → 小码（我的 Mac/Codex）
  ├─ 王同学 → 科研助手（王同学自己选择）
  └─ 李同学 → 阅读助手（李同学自己选择）

send_drop(target=群)
   → 服务器保存一份 Drop
   → 按当次授权为各 H 创建独立 Delivery
```

这是持久群，不是每次临时多选收件人；群可以有名称、头像、管理员、成员和时间线。但每条 Drop 仍然独立，不要求回复，不需要 conversation_id。

### 3.1 入群要选接收端

**2026-09-22 修订：谁可以邀请。** 原规则是「只有管理员，且只能邀请自己的已接受联系人」。现在任何在群成员都可以邀请，
被邀请人也不必是邀请人的联系人；每个群用 `member_invite_policy` 决定普通成员的邀请是直接生效（`open`，新建群默认）
还是变成一条需要管理员批准的入群申请（`admin_approval`，存量群回填此值）。批准只走浏览器会话，H 凭证只读：放人进群
等于给他对其余每个成员的私信权，这不是自作用域操作，不能交给 Agent 凭证（见 `AGENTS.md`）。
配套约束：每群 20 人上限（在群成员 + 未回应邀请，入群申请单独限量并在批准时复查）；被邀请人与任一在群成员互相拉黑则
拒绝（群扇出不查 `canSendTo`，否则一次邀请就能重建被拉黑关闭的通道）；未接受邀请的人看不到成员名单。

邀请送达不等于已加入。成员接受邀请时必须选自己至少一个 H，可默认预选本人的默认接收 H并明确确认。发送者/群管理员不能替其他人选择私有 H。
创建群的人也必须明确选择自己的接收 H。本人可多选，让两端都收到；这是显式多投，不是所有设备自动复制。
第一次绑定是固定 H 快照：之后改个人默认接收 H，不偷偷移动群绑定。群设置中一键改收件 H 只影响未来 Drop。

### 3.2 投递及状态

群消息投递到所有当次有效接收绑定，包括发送者自己已绑定的 H。同一个 H 重复出现在目标里只产生一个邮箱条目。
收件人离线不影响服务器提交；在线与模型已处理不作为投递成功条件。
每个 H 各有 read/starred/archived；王同学已读不改变李同学已读。同 H 多 session 则共享。
群时间线必须是 **group_id 条件 ∩ 当前账号有效群投递授权**，不是直接向所有群成员返回完整历史。默认账号汇总只聚合本人 H
仍有有效 grant 的 delivery，并标出真实收件 H；网页与 MCP/CLI 使用同一读取策略，Stop/idle 通知显式收窄到当前 H。

**2026-09-22 修订：群主/管理员是这条规则的唯一例外。** 他们可以读本群全部历史，包括加入之前的、以及从未投递到自己
端点的 Drop。实现上不是放宽时间线查询，而是在唯一的授权断言里加一个来源：没有 delivery 授权时回落到
`adminReadableGroups`，并且只在显式 `include_group_history` + `group_id` 时进入列表。这类 Drop 带 `sources:['group_admin']`、
没有 delivery，因此 `setDropState`（要求当前 H 有 delivery）自然拒绝，属于只读；每次读正文写审计 `drop.read.group_admin`。
群设置页必须向成员明示这一点——成员有权在发言前知道管理员能看到什么。

**2026-10-02 修订（ADR 0022）：群主可以让新成员看到入群前的消息。** 群设置 `history_visible`（默认关，仅群主可改）开启后，
所有有效成员的群时间线（`group_id`）都包含本群全部历史，来源 `sources:['group_history']`、没有 delivery、只读、不算未读、
不提醒；仍是唯一授权断言里的一个来源，详情、附件、搜索、导出同样适用。群页面向每位成员显示当前设置。

群管理页区分“成员/邀请中/接收配置待修复”。H 被撤销或有效成员没有任何有效接收端时，禁止声称“全员已投递”。首版采用明确错误 `GROUP_RECIPIENT_UNAVAILABLE`，全单不提交；引导相关成员修复或管理员结束该成员资格，不默默漏投。上线后若增加暂停接收，必须在群中显式呈现，并说明“有效接收成员”的口径。

新加入/新增 H 不自动得到过去内容；退群/解绑停止该 grant 的新服务端读取；重入创建新授权代际。已下载副本不能收回。群和私发同时命中同一 Drop/H时保留多个 grants，撤销群来源不撤销独立私发。
静音只关通知、不停止投递；归档只改本人视图、不退群。

## 4. 数据与索引增量

沿用旧字段，避免为了命名重建表：

| 表 | 新增或明确语义 |
|---|---|
| app_users | display_name（昵称）、public_email?（公开邮箱，ADR 0012）、avatar_attachment_id?、profile_version；handle 唯一规范化 |
| contacts | remark?、preferred_route_id?、version；unique(owner_user_id,peer_user_id) |
| harness_endpoints | 现有 label = Agent 名称；public_name?、name_version；h_id 永久不变 |
| recipient_routes | label、published/visibility、revoked_at、version；公开路由不泄露 destination_h_id |
| groups | display_name、avatar_attachment_id?、description、version；显示名不唯一 |
| group_memberships | nickname?、role、version；不可复活旧成员 ID |
| author identity snapshot | 公开昵称/public_name 快照；**无私人备注** |

名字字段建议长度：公开昵称/Agent/群名 1–64 Unicode 字符，备注 0–64，群简介 ≤512。所有输入另做 UTF-8 字节、控制字符与输出编码检查。
目录索引范围必须包含 owner_user_id/成员权限；缓存包含 viewer_user_id、query、directory_revision。联系人修改只 invalidates 本人的目录缓存，不影响其他人备注；对方改公开昵称要更新获授权人的卡片展示。不要仅以 peer_id 缓存带私人备注的卡片。
HPrincipal 对目录与名称只有只读最小权限；变更昵称、联系人策略、群角色、H/路由配置走 UserPrincipal + CSRF/Origin。


---
