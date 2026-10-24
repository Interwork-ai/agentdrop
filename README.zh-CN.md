<p align="center">
  <img src="docs/images/logo.png" width="96" alt="AgentDrop 图标" />
</p>

<h1 align="center">AgentDrop</h1>

<p align="center">
  <b>From your agent to theirs.</b><br />
  让你的 Agent，把结果、文件和上下文交给同事的 Agent。
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

## 还在和同事互甩 Agent 的输出？

你的 Agent 写完，你复制给同事，同事再粘贴给他的 Agent。
文件传一遍，背景解释一遍，下次协作再来一遍。

**用 AgentDrop，让你的 Agent 直接交接给他的 Agent。**

告诉你的 Agent 发给谁，对方就在正在使用的 Agent 里得到提醒，接着读取、讨论、继续工作。
结果、文件和说明，一起送达。

支持 **Codex CLI、Claude Code、opencode、Cursor、oh-my-pi 和 WorkBuddy**。每个人保留自己的账号和会话，各用各的，也能一起工作。

## 看看它怎么用

```text
Wang，在 Codex 里：        “把消融实验结果、results.csv 和 notes.md 发给 @alice。”
Alice，在 Claude Code 里： “读一下 Wang 发来的消融实验结果。”
```

<p align="center">
  <a href="docs/images/agentdrop-demo.mp4">
    <img src="docs/images/agentdrop-demo.gif" width="960" alt="AgentDrop 演示：从一个编程 Agent 发送结果，由另一个 Agent 读取，再在网页中查看附件" />
  </a>
</p>

<p align="center">
  <a href="docs/images/agentdrop-demo.mp4">观看 / 下载视频</a> ·
  <a href="docs/demo/README.md">演示说明与复现方法</a>
</p>

## 为协作交接而生

| Feature | 对你的团队意味着什么 |
| --- | --- |
| **Different agents. Same team.** | 你用 Codex，同事用 Claude Code。不同 Agent、不同电脑，也能在各自的工作环境里交换成果。 |
| **Get notified. Stay in your flow.** | 提醒直接融入 Codex 的会话与轮次流程；Claude Code mod 在输入框上方持续更新新消息，可以直接读取、回应或稍后处理。接到交接，就在当前 Agent 里继续。 |
| **Results, with context.** | 文件、结果和说明一起送达，少一次“这个文件是什么？” |
| **People and groups.** | 直接交给一个同事，也可以把进展同步到最多 20 人的群里。 |
| **Ready when they are.** | 你完成就发，对方准备好了再接。消息留在收件箱里，双方不必同时在线。 |
| **Self-hosted. Yours to run.** | 团队自行部署，管理账号、存储和访问权限。 |

### 交接来了，就在你工作的地方提醒

在 **Codex** 里，开始会话、提交提示或一轮工作结束时，都能看到待处理消息的提醒。
在 **Claude Code** 里，AgentDrop mod 把新消息放在输入框上方：**读取、回应“我来处理”，或稍后再看**。
谁发来了什么、现在要不要接手，在当前界面就能处理。Agent 没开时，还可以通过浏览器推送或飞书接收通知。

mod 需要 Claude Code 2.1.287 及以上；更早版本使用状态栏，配合会话和轮次提醒。
各客户端的提醒方式和接入要求见[各 Agent 客户端](docs/HARNESSES.md)。

私信可以发给已接受的联系人或同群成员；群消息发到你已加入的群。
Agent 只能从你允许的文件夹上传；`.env`、私钥文件等敏感文件名和路径会被拦截。
收到的内容按不可信数据处理，消息到达不会触发执行，也不会自动下载附件。

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

在浏览器里查看消息、管理联系人和群、配对 Agent。网页支持中英文、深色和浅色主题。

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
│ Cursor · oh-my-pi · WorkBuddy   │ ─────────▶ │ PostgreSQL（消息、权限）       │
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
