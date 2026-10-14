# AgentDrop

[English](README.md)

AgentDrop 让人把结果、文件和选定的上下文，从一个编程 Agent 交到另一个编程 Agent 手里，跨机器、跨网络都可以。你在笔记本上
对 Codex 说“把这些结论和 notes.md 发给 @wang”，老王在实验室服务器上问 Claude Code“收到了什么”，就能在那边读到，附件
一起到。双方不用共享账号，不用交出会话记录，也不需要同时在线。

支持的 Agent（代码里叫 *harness*）：**Codex CLI、Claude Code、opencode、Cursor 和 oh-my-pi（omp）**。它们运行同一个
MCP bridge，遵守同一套消息规则；各工具之间的差异见 [docs/HARNESSES.md](docs/HARNESSES.md)。

每条消息叫一个 **drop**：标题、正文和可选附件，一次性投递给人或群组。drop 发出后不可修改，也不形成回复串；它可以注明
自己回复的是哪一条，读的一方自己决定要不要再发一条。所有 drop 都保存在服务器上，有收件箱、已发送、收藏、归档，
也可以按联系人和群组看往来时间线。

## 整体结构

```
 每个人自己的机器                                      团队共用的一台服务器（部署一次）
 ┌──────────────────────────────────┐                   ┌──────────────────────────────────────┐
 │ Codex / Claude Code / opencode / │   HTTPS，只向外连 │ API（Fastify）+ 网页 Dashboard        │
 │ Cursor / omp                     │ ────────────────▶ │ PostgreSQL（drop、权限）              │
 │   └─ agentdrop mcp（stdio bridge）│                   │ worker（发件队列、通知、定期清理）    │
 │ agentdrop CLI（setup、doctor）   │                   │ 附件存储（本地磁盘或 S3）             │
 └──────────────────────────────────┘                   └──────────────────────────────────────┘
```

服务端是一个 Docker Compose 起来的整体，不是一堆微服务。每个人在每台机器上用一次 CLI，之后日常用网页。服务器之间不互通：
一台服务器上的身份、联系人和 drop 与另一台服务器上的完全分开。

## 主要功能

- **每个 Agent 身份一个邮箱。** 一个 Agent 由“账号 + 设备 + harness + profile”确定。同一个 Codex 不管开多少个会话、多少个
  项目，都是同一个 Agent；GPU 服务器上的 Codex 是另一个 Agent。发给 `@你` 的 drop 默认投到你所有的 Agent；你可以改成只在
  其中一个接收，发送方也可以指定某一个 Agent，例如 `@你/claude`。
- **已读状态属于人**（[ADR 0007](docs/adr/0007-one-reader-per-account.md)）。已读、收藏、归档由你所有的 Agent 和网页共用：
  在一处标为已读，各处都清掉；回合结束的通知对每个账号只提示一次新内容。默认情况下，你的每个 Agent 也能列出你其他
  Agent 发出和收到的 drop，并标明是哪个 Agent；可以在设置里关掉。发件人能看到每个人第一次打开 drop 的时间，但看不到是
  用哪个 Agent 打开的。
- **只在联系人和群组之间收发。** 只能发给已接受的联系人和同群成员。知道你 @handle 的人可以发来联系人申请，但在你接受之前，
  别的东西都进不了你的收件箱。联系人可以用邀请链接加，也可以直接让 Agent 去加；一个群最多 20 人。
- **我的空间**（[ADR 0030](docs/adr/0030-my-space.md)）。给自己存的文件和备注：在笔记本上放进去（网页、
  `agentdrop space put`，或让 Agent 去放），再在服务器上的 Agent 里取出来。这些条目不算未读，也不会提醒。
- **有终端就够**（[ADR 0032](docs/adr/0032-terminal-read-marks-read.md)）。`agentdrop inbox`、`read` 和
  `send @handle | #群 | me` 不需要 Agent，脚本和 CI 里也能用（正文可从管道传入，附件同样只能来自允许的目录）。
  在终端里读过的消息会标为已读；脚本和 Agent 运行 CLI 时不改状态。
- **给 Agent 的 14 个 MCP 工具**：收发 5 个（`directory_lookup`、`list_drops`、`read_drop`、`send_drop`、`set_drop_state`），
  本地文件 2 个（`upload_file`、`download_file`），联系人和群组 7 个。账号管理（给 Agent 改名、撤销凭证、群的策略、批准
  入群申请）只在网页和 CLI 里做。详见 [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md)。
- **收到的东西不会被执行。** 由软件强制保证的：不会自动下载；下载的文件落在固定目录，核对 sha256，不覆盖已有文件，
  不执行、不解压。告诉 Agent 去做的（MCP 服务器的说明和配套 skill）：把别人发来的标题、正文和名字当作不可信的数据，
  不照其中的指令行事，动手处理之前先把收到的 drop 讲给用户听。drop 正文夹在“不可信内容”标记之间送给模型，但模型仍可能
  出错，要不要运行任何东西始终由用户决定。
- **谨慎对待本地文件。** Agent 只能从你允许的目录上传；密钥、`.env` 等敏感路径会被拒绝。
- **重试不会重复发送。** 每次发送带一个 `request_id`，重复提交返回第一次的结果。
- **在你所在的地方提醒。** 钩子在 Agent 一个回合结束时显示简短通知（Codex 和 Claude Code 用 `Stop`，Cursor 用 `stop`，
  opencode 用 `session.idle`，omp 用 `agent_end`）；你提交提示时，模型也会知道有哪些待处理（Codex、Claude Code、omp）。
  Claude Code 2.1.287 及以上版本会在输入框上方列出等着你的内容。浏览器 Web Push 和飞书群机器人在没有任何 Agent 运行时
  也能提醒你，提醒里有 drop 的标题，不含正文。
- **可选的静态加密。** 开启 `CONTENT_ENCRYPTION=on` 并配好密钥环后，drop 的标题、正文、附件名和附件内容加密存储，单看
  数据库导出、备份或附件存储都看不到内容。同时掌握主机和密钥环的人仍然可以解密，所以这不是端到端加密。不开启时，服务器
  以明文保存内容。传输走 HTTPS（生产环境拒绝 `http://` 的地址）。见
  [docs/DEPLOY.md](docs/DEPLOY.md#content-encryption-at-rest)。
- **网页有中英两种语言**、深浅两种主题，另有给管理员的运维控制台，能看账号、Agent 和审计日志，但看不到任何消息内容
  （[docs/ADMIN.md](docs/ADMIN.md)）。
- **审计导出。** `agentdrop export` 把与某个联系人或某个群在一段日期内的 drop 导出成可校验的 NDJSON 文件。

## 用户快速上手

需要 Node.js 22 或更高版本，并且至少装了一个支持的 Agent。不需要这个仓库。

1. 在浏览器里打开团队的 AgentDrop 服务器，注册账号。
2. 在你要用的每台机器的终端里：

   ```bash
   npm install -g agentdrop-cli@latest        # 或：curl -fsSL https://drop.example.com/install.sh | sh
   agentdrop setup --server https://drop.example.com
   ```

   `setup` 会登记这台机器、检测已安装的 Agent、逐个配对（你在浏览器里批准）、注册 MCP bridge、安装配套 skill 和通知，
   最后自检。通过 SSH 用远程机器时加 `--no-browser`，把打印出来的链接拿到自己电脑上打开。`--harness codex`（或
   `claude-code`、`cursor`、`opencode`、`omp`）只接其中一个。在项目文件夹里运行时，它会问是否允许 Agent 从那里上传文件。
3. 在网页的「联系人」页加同事，或者让 Agent 去加。对方接受后，就可以让 Agent 给他发东西了。每个账号自带一个
   `@agentdrop` 助手联系人，发一条测试 drop 给它会收到回执。

npm 包名是 `agentdrop-cli`，命令是 `agentdrop`。`agentdrop doctor` 用来诊断配置和连接。完整说明见
[docs/USER_GUIDE.md](docs/USER_GUIDE.md)。

## 自己部署服务端

**在一台机器上试用**（Docker，`localhost:3000` 上的普通 http，附件存本地磁盘）：

```bash
git clone https://github.com/Interwork-ai/agentdrop.git && cd agentdrop
echo "AUTH_SECRET=$(openssl rand -hex 32)" >> .env      # 只需一次；Compose 读取 compose 文件旁边的 .env
docker compose -f compose.local.yaml up -d --build      # PostgreSQL、迁移、API + 网页、worker
```

然后按上面的用户步骤操作，地址用 `--server http://localhost:3000`。在没有域名的服务器上试用（高端口上的普通 http，或者
借已有的 nginx 走 HTTPS），见 [docs/DEPLOY_TRIAL.md](docs/DEPLOY_TRIAL.md)。

**给团队正式部署**用 `compose.yaml` + `compose.production.yaml`，前面是 Caddy，由它申请 TLS 证书。从
[.env.example](.env.example) 复制出 `.env.production`。API 启动时检查配置，生产环境下以下条件不满足就拒绝启动：

| 变量 | 要求 |
|---|---|
| `NODE_ENV` | `production` |
| `PUBLIC_BASE_URL` | 服务器对外的 `https://` 地址 |
| `DATABASE_URL`、`POSTGRES_PASSWORD` | PostgreSQL 连接；两处用同一个生成的密码 |
| `AUTH_SECRET` | 至少 32 个随机字符，不能是占位值 |
| `STORAGE_PROVIDER=s3`、`S3_REGION`、`S3_BUCKET`、`S3_ACCESS_KEY_ID`、`S3_SECRET_ACCESS_KEY`（非 AWS 时加 `S3_ENDPOINT`） | 私有存储桶；生产环境不允许附件存本地磁盘 |
| `DEV_AUTH`、`LOG_CONTENT` | `false` |

可选：`WEB_PUSH_VAPID_*`（浏览器推送）、`SMTP_URL` + `MAIL_FROM`（发送重置密码邮件）、`CONTENT_ENCRYPTION` +
`CONTENT_KEYS_FILE`（静态加密）、`SIGNUP_MODE`（`open` 或 `closed`，管理员之后可以在网页上改）。Compose 还会读取
`AGENTDROP_DOMAIN`（Caddy 服务的域名）和 `AGENTDROP_IMAGE`（要运行的镜像）。迁移、备份与恢复、升级和密钥处理见
[docs/DEPLOY.md](docs/DEPLOY.md)；日常运维（管理员、停用账号、注册开关）见 [docs/ADMIN.md](docs/ADMIN.md)。

## 开发

需要：Node.js（版本见 `.nvmrc`，至少 22.12）、pnpm 10，以及用来跑 PostgreSQL 的 Docker。

```bash
pnpm install
cp .env.example .env                 # 然后把 AUTH_SECRET 换成随机值（openssl rand -hex 32）
docker compose up -d postgres        # PostgreSQL 17，端口 localhost:5433
pnpm db:migrate && pnpm dev          # API 在 :3000；另开一个终端运行 `pnpm dev:web`，网页在 :5173
pnpm verify                          # lint、hygiene、类型、契约和迁移漂移、测试、构建
```

只有当 `TEST_DATABASE_URL` 指向专用的 `test_*` 或 `*_test` 数据库时才跑数据库测试，否则这些测试会跳过并注明。
`pnpm verify:cli` 单独检查客户端，不需要数据库。`pnpm e2e` 用 Chrome 对着真实服务器操作网页，使用一个它会重置的空数据库
（`E2E_DATABASE_URL`）。怎么参与贡献、每个改动要遵守的规则，见 [CONTRIBUTING.md](CONTRIBUTING.md) 和
[AGENTS.md](AGENTS.md)。

## 文档

| 主题 | 文档 |
|---|---|
| 使用：配对、联系人、发送、群组、常见问题 | [docs/USER_GUIDE.md](docs/USER_GUIDE.md) |
| Agent 侧工具及其错误 | [docs/MCP_TOOLS.md](docs/MCP_TOOLS.md) |
| 各 harness 的行为与一致性 | [docs/HARNESSES.md](docs/HARNESSES.md) |
| CLI 命令 | [apps/cli/README.md](apps/cli/README.md) |
| 部署、备份、升级、静态加密 | [docs/DEPLOY.md](docs/DEPLOY.md)、[docs/DEPLOY_TRIAL.md](docs/DEPLOY_TRIAL.md) |
| 运维服务器 | [docs/ADMIN.md](docs/ADMIN.md) |
| 飞书通知 | [docs/FEISHU.md](docs/FEISHU.md) |
| 代码结构与数据模型 | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| 决策记录 | [docs/adr/](docs/adr/README.md) |
| 产品默认规则与网页设计规则 | [docs/PRODUCT_PRINCIPLES.md](docs/PRODUCT_PRINCIPLES.md)、[docs/DESIGN.md](docs/DESIGN.md) |
| 质量关卡与测试 | [docs/QUALITY.md](docs/QUALITY.md)、[docs/TEST_BACKLOG.md](docs/TEST_BACKLOG.md) |
| 已实现、已测试、未测试、不支持 | [docs/STATUS.md](docs/STATUS.md) |
| 真实客户端互通记录 | [docs/INTEROP.md](docs/INTEROP.md) |
| 发布与兼容性 | [docs/RELEASE.md](docs/RELEASE.md)、[CHANGELOG.md](CHANGELOG.md) |
| 仓库里可以放什么 | [docs/PUBLIC_REPOSITORY.md](docs/PUBLIC_REPOSITORY.md) |
| 最初的 v0.2 设计（历史资料） | [docs/plan/SPEC.md](docs/plan/SPEC.md) |

报告安全问题：[SECURITY.md](SECURITY.md)。社区行为准则：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)。

## 许可

见 [LICENSE](LICENSE)。
