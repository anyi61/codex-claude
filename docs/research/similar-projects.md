# Similar Projects: Codex CLI ↔ Claude Code Task Delegation

> 搜索结果汇总 — 2026-05-05
> 本项目 `codex-claude-delegate` 是一个 MCP 服务器，允许 Codex CLI 将任务委托给 Claude Code 执行。

---

## 一、直接竞品 / 同类桥梁项目

### 1.1 codex-mcp-bridge (hampsterx)

- **GitHub**: https://github.com/hampsterx/codex-mcp-bridge
- **方向**: Codex CLI → MCP 工具（双方向，支持 Claude Code、Gemini CLI、Cursor 等作为客户端）
- **技术栈**: Node.js + TypeScript + MCP
- **特点**: MCP server 包装 Codex CLI 为子进程，暴露 code_exec、search、query、review 工具；支持 sandbox 控制、结构化输出
- **Stars**: 活跃
- **与本项目异同**: 方向相反——它把 Codex 作为 MCP tool 暴露给其他客户端；本项目把 Claude 作为 Codex 的 MCP tool

### 1.2 claude-codex-bridge (npm: claude-codex-bridge)

- **GitHub**: 双向 MCP server bridge
- **方向**: 双向 — Claude Code 可调用 Codex，Codex 也可调用 Claude
- **技术栈**: Node.js + pnpm
- **特点**: 使用两个独立的 MCP server（codex-server + claude-server）；Claude → Codex 用 MCP；Codex → Claude 用 `~/.codex/config.toml`
- **安装**: `npm install -g claude-codex-bridge`
- **工具**: codex_query, codex_review_code, codex_review_plan, codex_explain_code, codex_plan_perf, codex_implement（以及反向的 claude_* 工具）
- **与本项目异同**: 功能更全面（双向），但本项目更专注于 Codex → Claude 单向委托 + worktree 隔离 + 安全约束

### 1.3 codex-bridge (eLyiN)

- **GitHub**: https://github.com/eLyiN/codex-bridge
- **方向**: AI 客户端（Claude Code、Cursor 等）→ Codex CLI
- **技术栈**: Python + MCP
- **特点**: 轻量级 MCP server，通过官方 Codex CLI 与 OpenAI 模型交互；支持多 MCP 客户端
- **Stars**: 较新

### 1.4 codex-bridge (abhishekgahlot2)

- **GitHub**: https://github.com/abhishekgahlot2/codex-claude-bridge
- **方向**: 双向实时对话（基于 Claude Code Channels）
- **技术栈**: Node.js + Claude Code Channels + MCP + tmux
- **特点**: 利用 Claude Code 新发布的 Channels 功能实现双向推送；Web UI 实时查看对话
- **与本项目异同**: 实时双向协作 vs 本项目的一次性任务委托

### 1.5 claude_codex_bridge (bfly123)

- **GitHub**: https://github.com/bfly123/claude_codex_bridge
- **方向**: 实时多 AI 协作（Claude + Codex + Gemini）
- **特点**: 支持持久化上下文、最小 token 开销；包含多个技能文件
- **Stars**: 528 commits

### 1.6 codex-claude-bridge (Claude Code Bridge)

- **方向**: 跨模型实时协作
- **特点**: 使用 tmux split-pane 展示多个 agent 实时工作；支持 Claude + Codex + 多模型并行
- **相关**: https://www.verdent.ai/guides/claude-code-bridge-terminal-ai-agents

### 1.7 codex-plugin-cc (OpenAI 官方)

- **GitHub**: https://github.com/openai/codex-plugin-cc
- **方向**: Claude Code → Codex（正向，与本项目反向）
- **Stars**: ~17k
- **特点**: OpenAI 官方维护的 Codex Plugin for Claude Code；通过 Hooks + Codex App Server 实现
- **架构参考**: Claude Code → Hooks → codex-companion.mjs → Codex App Server (JSON-RPC)
- **与本项目异同**: 方向相反（Claude → Codex），但架构可参考

---

## 二、Agent 编排 / 多 Agent 协作框架

### 2.1 ensemble (Claude Code + Codex 协作)

- **方向**: 多 agent 实时对话（Claude + Codex + Gemini + Aider）
- **特点**: tmux + 消息总线实现多 agent 协作；自动生成可分享的 HTML 回放
- **模式**: 实时双向对话

### 2.2 ccswarm

- **GitHub**: https://github.com/nwiizo/ccswarm
- **方向**: 多 agent 编排系统
- **技术栈**: Rust
- **特点**: Claude Code + Git worktree 隔离 + 专业 agent 池（Frontend/Backend/DevOps/QA）
- **TUI**: ratatui 实时监控
- **Stars**: 活跃

### 2.3 oh-my-claudecode (OMC)

- **方向**: Claude Code 编排层（插件系统）
- **特点**: Hooks + Skills + Agents + State 四层架构；支持跨模型检查（Claude + Codex + Gemini）

### 2.4 sub-agents-mcp (shinpr)

- **GitHub**: https://github.com/shinpr/sub-agents-mcp
- **方向**: 跨 MCP 客户端的子 agent 系统
- **特点**: 在 Markdown 中定义 agent，通过 Cursor CLI / Claude Code / Gemini CLI / Codex 执行
- **与本项目异同**: 关注子 agent 的标准化定义和执行，不限于单个模型

### 2.5 sub-agents-skills

- **方向**: 更轻量的跨模型子 agent 方案（无 MCP server）
- **特点**: Skill 文件定义，不依赖 MCP server 配置

### 2.6 helix-codex

- **方向**: Claude Code → Codex CLI MCP bridge
- **特点**: 单文件实现（~820 行），零外部依赖；支持结构化 JSONL 执行追踪

### 2.7 CrewAI

- **GitHub**: https://github.com/crewAIInc/crewAI
- **方向**: 通用多 agent 编排框架
- **技术栈**: Python
- **特点**: 角色定义、任务分解、工具绑定、记忆管理；最成熟的开源多 agent 框架之一
- **与本项目异同**: 通用框架 vs 专注 Codex → Claude 委托场景

### 2.8 Baton

- **方向**: Issue 驱动 agent 编排
- **特点**: GitHub Issue → worktree → agent → PR 的自动化流水线
- **支持**: Claude Code, Codex CLI, OpenCode, Gemini CLI

### 2.9 Emdash

- **方向**: 任务级 agent 编排
- **特点**: Git worktree + 自动端口分配（`$EMDASH_PORT`）；支持 setup/run/teardown 脚本

---

## 三、MCP Tool / 安全沙箱 / 代码执行

### 3.1 sandbox-mcp

- **GitHub**: PyPI sandbox-mcp
- **方向**: 安全的 Python 代码执行沙箱
- **特点**: 基于 MCP 的代码执行隔离；支持进程池、内存限制、网络隔离

### 3.2 code-sandbox-mcp (philschmid)

- **GitHub**: https://github.com/philschmid/code-sandbox-mcp
- **方向**: 容器化代码执行沙箱
- **特点**: 基于 Docker 的 STDIO MCP server；支持多种语言

### 3.3 mcp-run-python (pydantic)

- **GitHub**: https://github.com/pydantic/mcp-run-python
- **方向**: Python 代码执行
- **特点**: Deno 沙箱中运行 Python；支持依赖安装

### 3.4 Proxima

- **方向**: 多 AI provider MCP server
- **特点**: 在 Cursor/VS Code/Claude Desktop 中同时使用 ChatGPT + Claude + Gemini + Perplexity

---

## 四、Git Worktree 隔离工具

### 4.1 claude-worktree-tools (ThinkVelta)

- **方向**: Claude Code worktree 管理技能包
- **特点**: 一键安装到 repo，支持 /wt-open /wt-merge /wt-close 命令；自动端口偏移

### 4.2 agentree

- **方向**: AI workflow worktree 快捷创建
- **命令**: `agentree -b fix-auth`

### 4.3 git-worktree-runner (CodeRabbit)

- **方向**: 多 AI 工具 worktree 管理
- **支持**: Claude, Cursor, Opencode, Copilot, Gemini
- **命令**: `git gtr new my-feature --ai`

### 4.4 worktree-cli

- **方向**: AI workflow 的 worktree 管理（MCP 集成）
- **特点**: Claude Code MCP server 集成 + 自动 setup hooks + .env 处理

### 4.5 gwq

- **方向**: worktree 状态仪表盘
- **特点**: 跨仓库 worktree 状态查看 + tmux 集成

---

## 五、平台级 / IDE 集成方案

### 5.1 Cursor 3.0 (Glass)

- **方向**: 多 agent IDE
- **特点**: 专用 Agents Window；最多 8 个并行 agent；git worktree 隔离；多模型执行
- **命令**: `/best-of-n` 将同一 prompt 发送给多个模型

### 5.2 VS Code 多 Agent 模式 (2026.01)

- **方向**: IDE 多 agent 管理
- **特点**: Agent Sessions 视图统一管理 Copilot + Claude + Codex 会话
- **博客**: https://code.visualstudio.com/blogs/2026/02/05/multi-agent-development

### 5.3 JetBrains Air (2026.1)

- **方向**: 多 agent 桌面应用
- **支持**: Codex, Claude Code, Gemini CLI, Junie
- **特点**: 独立的桌面 app；支持 Docker + git worktree 隔离

### 5.4 GitHub Agent HQ

- **方向**: 平台级多 agent
- **特点**: 在 GitHub / VS Code 内使用 Claude + Codex + Copilot；PR 驱动

### 5.5 Codex App (Cloud)

- **方向**: 异步任务池
- **特点**: 在云端 VM 上运行 agent；支持并行委托、多 agent；桌面 + CLI + Web 统一状态

---

## 六、协议 / 标准层

### 6.1 MCP (Model Context Protocol)

- **创建者**: Anthropic, 2024.11
- **用途**: Agent → Tool 连接标准
- **下载**: ~97M (2026 年初)
- **创始人**: Linux Foundation (AAIF)
- **成员**: AWS, Anthropic, Block, Bloomberg, Cloudflare, Google, Microsoft, OpenAI

### 6.2 A2A (Agent-to-Agent)

- **创建者**: Google, 2025.04
- **用途**: Agent → Agent 通信
- **与本项目**: MCP 连接工具，A2A 连接 agent

### 6.3 ACP (Agent Communication Protocol)

- **创建者**: IBM / BeeAI, 2025
- **用途**: 本地 agent-to-agent 通信

---

## 七、关键分类对比

| 分类 | 项目 | 方向 | 技术栈 | 是否本项目的直接竞品 |
|------|------|------|--------|---------------------|
| **反向桥梁** | openai/codex-plugin-cc | Claude → Codex | Hooks + JSON-RPC | 方向相反，参考架构 |
| **双向桥梁** | claude-codex-bridge (npm) | Claude ↔ Codex | Node.js + MCP | ✅ 直接 |
| **单向桥梁** | codex-mcp-bridge (hampsterx) | Codex → 客户端 | Node.js + MCP | ✅ 最接近 |
| **实时对话** | ensemble / claude-codex-bridge (abhishekgahlot2) | 双向实时 | Channels + tmux | 模式不同 |
| **编排框架** | CrewAI | 通用编排 | Python | 通用 vs 专用 |
| **安全沙箱** | sandbox-mcp | 代码执行 | Python | 互补 |
| **IDE 平台** | Cursor 3 / VS Code / JetBrains Air | 多 agent | 集成环境 | 平台级 |

---

## 八、本项目独特优势

1. **Codex → Claude 单向委托**：专为 Codex 规划 + Claude 执行设计，目前最专注此方向的实现
2. **三层安全防护**：环境变量清理 + 递归检测（BRIDGE_DEPTH）+ cwd 白名单
3. **server_observed 验证**：不信任 agent 自述，服务端独立观测实际变更
4. **Worktree 隔离**：每次 implement 在独立 worktree 中执行
5. **JSON Schema 结构化输出**：三种不同的 schema（query / review / implement）
6. **会话复用策略**：query 自动复用、review 禁用持久化、implement 显式复用
7. **资源控制**：max_cost_usd + max_changed_files 双重限制
8. **被委托 agent 的反委托约束**：防止递归委托链
