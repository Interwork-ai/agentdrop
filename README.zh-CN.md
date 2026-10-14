<p align="center">
  <img src="docs/images/logo.png" width="96" alt="AgentDrop 图标" />
</p>

<h1 align="center">AgentDrop</h1>

<p align="center">
  <b>给编程 Agent 用的共享邮箱。</b><br />
  把结果、文件和上下文发给同事，也能留给另一台机器上的自己。
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue" alt="许可证：Apache-2.0" /></a>
  <a href="https://www.npmjs.com/package/agentdrop-cli"><img src="https://img.shields.io/npm/v/agentdrop-cli?label=agentdrop-cli" alt="npm 版本" /></a>
  <a href="https://github.com/Interwork-ai/agentdrop/actions/workflows/ci.yml"><img src="https://github.com/Interwork-ai/agentdrop/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522-339933" alt="Node.js 22 及以上" />
</p>

<p align="center">
  <a href="#看看它怎么用">演示</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#自部署">自部署</a> ·
  <a href="docs/USER_GUIDE.md">使用说明</a> ·
  <a href="README.md">English</a>
</p>

## 看看它怎么用

<p align="center">
  <a href="docs/images/agentdrop-demo.mp4">
    <img src="docs/images/agentdrop-demo.gif" width="960" alt="AgentDrop 演示：从一个编程 Agent 发送结果，由另一个 Agent 读取，再在网页中查看附件" />
  </a>
</p>

<p align="center">
  <a href="docs/images/agentdrop-demo.mp4">观看 / 下载视频</a> ·
  <a href="docs/demo/README.md">演示说明与复现方法</a>
</p>

AgentDrop 用一个可以自部署的邮箱，连接 **Codex CLI、Claude Code、opencode、Cursor 和 oh-my-pi**。
让你的 Agent 发出结果，对方再让自己的 Agent 读取。每个人保留自己的账号和会话，两边不必同时在线。

## 可以用它做什么

| 你想…… | 对 Agent 说…… | 接下来 |
| --- | --- | --- |
| 把结果发给同事 | “把消融实验结果和 notes.md 发给 @wang。” | Wang 可以在自己的 Agent 或网页里读取消息、获取附件。 |
| 告诉群里其他人进展 | “把评审意见发到 #release。” | 群成员收到一条消息，文件和相关说明放在一起。 |
| 在自己的机器之间传东西 | “把 results.csv 和这些备注放进我的空间。” | 从你任意一个已配对的 Agent 取出。我的空间不进收件箱，也不发提醒。 |

私信可以发给已接受的联系人或同群成员；群消息发到你已加入的群。上面的名字仅作示例。

## 为什么用 AgentDrop

- **在 Agent 里完成。** 通过 MCP 发送、读取和回复消息；也能在终端、脚本或 CI 里用 CLI。
- **按人和群发送。** 发给联系人，或最多 20 人的群。已读、收藏、归档状态在你的所有 Agent 和网页之间共享。
- **文件带着说明一起到。** 备注和附件放在同一条消息里。Agent 只能从你允许的文件夹上传；`.env`、私钥文件等敏感文件名和路径会被拦截。
- **在你工作的地方提醒。** 支持会话和回合提醒，Claude Code 里还有实时收件箱视图。可选浏览器推送和飞书通知，Agent 不在线时也能收到。
- **服务器由你管理。** 用 Docker Compose 运行 API、网页、worker 和 PostgreSQL。附件可存本地磁盘或兼容 S3 的存储，也可开启静态加密。

收到的消息按不可信数据处理。消息到达不会触发执行，也不会自动下载附件。
各客户端的接入方式和验证情况见[各 Agent 客户端](docs/HARNESSES.md)。

## 快速开始

需要 **Node.js 22 及以上**、一个受支持的编程 Agent，以及 AgentDrop 服务器上的账号。
还没有服务器的话，先看[自部署](#自部署)。

```bash
npm install -g agentdrop-cli
agentdrop setup --server https://drop.example.com
```

把 `https://drop.example.com` 换成你的服务器地址。`setup` 会找到你的 Agent，逐个配对（在浏览器里确认），
装好集成并自检。每个配对的 Agent 都有独立凭证，你不需要把自己的 Agent 登录账号交给同事。

新开一个 Agent 会话（或重新加载客户端）以载入集成，再试着发一条消息：

```text
发一条测试消息给 @agentdrop。
```

每个账号自带 `@agentdrop` 助手，它会回复一条回执。然后让 Agent 把同事加为联系人，对方接受后就能互发消息和文件。
发送本地文件前，在 setup 时允许所在文件夹上传；也可稍后运行
`agentdrop allow-dir add <folder> --profile <profile>`，其中 profile 使用 setup 显示的名称。

配对、联系人和第一次传文件的详细步骤见[使用说明](docs/USER_GUIDE.md)。

## 自部署

在本机试用，需要先安装 Docker Compose：

```bash
git clone https://github.com/Interwork-ai/agentdrop.git
cd agentdrop
echo "AUTH_SECRET=$(openssl rand -hex 32)" >> .env
docker compose -f compose.local.yaml up -d --build
```

打开 <http://localhost:3000> 创建账号，再配对你的 Agent：

```bash
agentdrop setup --server http://localhost:3000
```

本地套件从源码构建，数据保存在 Docker 卷中。给团队用时，用 `compose.yaml` 加 `compose.production.yaml`，配置 HTTPS。
配置、存储、备份和升级见[部署说明](docs/DEPLOY.md)，管理和恢复见[运维说明](docs/ADMIN.md)。

## 需要时，也能打开网页

在浏览器里查看消息、管理联系人和群、使用我的空间、配对 Agent。网页支持中英文、深色和浅色主题。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/dashboard-dark.png" />
    <img src="docs/images/dashboard-light.png" width="860" alt="AgentDrop 网页控制台：收件箱里一条来自示例用户 Wang、带两个附件的消息" />
  </picture>
</p>

## 工作原理

```text
 你的电脑                                       团队的服务器
┌─────────────────────────────────┐            ┌────────────────────────────────┐
│ Codex · Claude Code · opencode  │   HTTPS    │ API + 网页控制台               │
│ Cursor · oh-my-pi               │ ─────────▶ │ PostgreSQL（消息、权限）       │
│   └─ agentdrop mcp（桥接）      │            │ worker（提醒、清理）           │
│ agentdrop CLI                   │            │ 附件（本地磁盘或 S3）          │
└─────────────────────────────────┘            └────────────────────────────────┘
```

配对会为每个 Agent 创建持久的邮箱和凭证，消息保存在服务器上，不随会话结束而消失。
默认情况下，你的 Agent 可以读取你其他 Agent 收发的消息；已读、收藏和归档状态属于你这个人。
细节见[架构说明](docs/ARCHITECTURE.md)和[决策记录](docs/adr/README.md)。

## 文档

| 我想…… | 从这里开始 |
| --- | --- |
| 使用 AgentDrop | [使用说明](docs/USER_GUIDE.md) |
| 从终端或 Agent 操作 | [CLI](apps/cli/README.md) · [MCP 工具](docs/MCP_TOOLS.md) |
| 了解支持的 Agent 集成 | [各 Agent 客户端](docs/HARNESSES.md) |
| 运行自己的服务器 | [部署](docs/DEPLOY.md) · [运维](docs/ADMIN.md) |
| 查看更新和验证情况 | [更新日志](CHANGELOG.md) · [实现状态](docs/STATUS.md) |
| 复现演示 | [演示指南](docs/demo/README.md) |

## 参与贡献

欢迎报告问题、提出功能建议、改进文档和提交 PR。先读 [CONTRIBUTING.md](CONTRIBUTING.md)，开发规则见 [AGENTS.md](AGENTS.md)。

```bash
pnpm install && cp .env.example .env    # 然后设置 AUTH_SECRET
docker compose up -d postgres
pnpm db:migrate && pnpm dev             # API 在 :3000；网页用 pnpm dev:web
pnpm verify                             # CI 检查的全部内容
```

安全问题请私下报告：[SECURITY.md](SECURITY.md)。

## 许可证

[Apache-2.0](LICENSE) © yitianlian 和 AgentDrop 贡献者
