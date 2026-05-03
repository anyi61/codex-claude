# Spec: Codex → Claude Code Task Delegation

## 1. 目标

让 **Codex CLI 规划任务后，把执行工作委托给 Claude Code**，Codex 验收结果。

不做：两个 agent 实时双向聊天、Claude 主动向 Codex 发消息。

## 2. 背景调研

### 2.1 已有方案

| 项目 | Stars | 方向 | 活跃 | 结论 |
|---|---|---|---|---|
| `openai/codex-plugin-cc` | 17k | Claude → Codex | 官方维护 | 正向插件，参考其架构 |
| `raysonmeng/agent-bridge` | 111 | 双向实时 | 活跃 | 实时双向桥（Claude Code Channels），非任务委托型 |
| `Dunqing/claude-codex-bridge` | 2 | 双向 MCP | 停滞 | 设计思路可参考，成熟度极低 |
| `AlessioZazzarini/claude-codex-collab` | 15 | Claude → Codex | 停滞 | 方向相反，非 Codex → Claude |
| `Leonard013/BigBrain` | 1 | Claude → Codex | 停滞 | 多模型 advisor，非反向委托 |

### 2.2 `codex-plugin-cc` 架构（参考）

```
Claude Code
  └─ Hooks (SessionStart/Stop)
       └─ Bash → codex-companion.mjs
            └─ Codex App Server (JSON-RPC over stdin/stdout)
                 └─ thread/start, turn/start, review/start
```

### 2.3 本项目的对称架构

```
Codex CLI
  └─ MCP Client (Codex 原生支持)
       └─ stdio ── codex-claude-delegate-mcp (Node.js MCP Server)
            └─ spawn("claude", argsArray) → claude -p
                 └─ --worktree, --json-schema, 结构化返回
```

### 2.4 关键决策：任务委托 vs 实时协作

- **任务委托（本项目选择）**：Codex 调一个 tool → Claude 子进程跑完 → 返回结果。简单、可控、不依赖实验特性。
- **实时协作**：两个 agent 进程同时运行，通过 WebSocket/Channels 互通。需要 Claude Code Channels（research preview）。参考 `agent-bridge`。

### 2.5 CLI 路径 vs Agent SDK 路径

| | `claude -p` | Claude Agent SDK |
|---|---|---|
| 认证 | 复用本地 Claude 订阅 | 需要 Anthropic API key |
| 控制粒度 | CLI flags | `ClaudeAgentOptions` 全量 |
| Session 管理 | `--resume` flag | `list/delete/fork/tag/resume` + 自定义 store |
| 流式输出 | `--output-format stream-json` | async iterator |
| 适合场景 | MVP / 个人使用 | 产品化 / 稳定分发 |

**Phase 1 用 CLI 路径**，复用本地订阅、快速验证。

## 3. 架构

### 3.1 核心链路

```
Codex 规划任务
  ↓ 调用 MCP tool
MCP server (stdio)
  ↓ validateCwd / checkRecursion / sanitizeEnv
spawn("claude", ["-p", "-w", ..., "--json-schema", ...])
  ↓ Claude 在隔离 worktree 中执行
解析 structured_output
  ↓ git diff --name-only / --stat (server_observed)
返回 { claude_report, server_observed } 给 Codex
  ↓
Codex 验收 diff，决定是否 apply
```

### 3.2 模块分工

```
src/
├── server.ts       # MCP server 入口，stdio transport，4 个 tool 路由
├── claude-cli.ts   # spawn claude -p 封装，3 种运行模式（query/review/implement）
├── guard.ts        # 安全：cwd 校验、env 清理、递归防护、exec 工具函数
└── schema.ts       # 类型定义、JSON Schema、结构化输出类型、prompt 构建器
```

## 4. MCP Tools

### 4.1 `claude_status`

检查 Claude Code CLI 可用性、认证状态、git worktree 支持。

- **入参**: `{ cwd: string }`
- **出参**: `ClaudeStatusResult { claude_available, claude_version, auth_status, git_available, worktree_capable, cwd_valid, cwd_is_git_repo, errors[] }`
- **不改文件**

### 4.2 `claude_query`

问 Claude 只读问题。Claude 可读文件、跑安全 git 命令，不可修改。

- **入参**: `{ task: string, cwd: string, timeout_sec?: number }`
- **出参**: `ClaudeReport`（通过 `--json-schema` 约束）
- **工具**: `--tools "Read,Glob,Grep,Bash"`
- **maxTurns**: 4
- **不改文件**

### 4.3 `claude_review`

让 Claude review 代码变更（diff 或当前工作区状态）。

- **入参**: `{ task: string, cwd: string, diff?: string, files?: string[], timeout_sec?: number }`
- **出参**: `ClaudeReport`
- **工具**: `--tools "Read,Glob,Grep,Bash"`
- **maxTurns**: 6
- **不改文件**

### 4.4 `claude_implement`

让 Claude 在隔离 worktree 中实现代码变更，运行测试，返回结构化结果 + 实际 diff。

- **入参**: `{ task: string, cwd: string, files?: string[], constraints?: string[], timeout_sec?: number }`
- **出参**: `{ claude_report: ClaudeReport, server_observed: ServerObserved }`
- **工具**: `--tools "Read,Glob,Grep,Edit,Write,Bash"`
- **maxTurns**: 8
- **隔离**: `--worktree codex-delegated-<runId>`
- **会改文件**（仅在 worktree 内）

### 4.5 结构化返回类型

```ts
interface ClaudeReport {
  status: "success" | "failed" | "partial" | "needs_user";
  summary: string;
  changed_files: string[];
  commands_run: string[];
  tests: { ran: boolean; command?: string; passed?: boolean; output_tail?: string };
  risks: string[];
  next_steps: string[];
}

interface ServerObserved {
  changed_files: string[];       // 实际 git diff --name-only
  diff_stat: string;              // 实际 git diff --stat
  diff_name_only: string;
  worktree_path?: string;
}
```

## 5. 安全设计

### 5.1 三层工具控制

Claude CLI 的三个 flag 职责不同，不能混淆：

| Flag | 作用 |
|---|---|
| `--tools` | **限制 Claude 能看到/使用哪些工具**（工具白名单） |
| `--allowedTools` | **哪些调用自动通过，不再询问权限**（免审批列表） |
| `--disallowedTools` | **哪些工具/pattern 彻底禁用**（硬禁止） |

正确的组合：

```bash
--tools "Read,Glob,Grep,Edit,Write,Bash" \
--allowedTools "Read" "Glob" "Grep" "Edit" "Write" "Bash(git status)" ... \
--disallowedTools "Bash(rm *)" "Bash(sudo *)" "Bash(curl *)" ...
```

### 5.2 非交互模式

```bash
--permission-mode dontAsk
```

`claude -p` 是非交互模式，`dontAsk` 确保遇到未批准的工具调用时自动拒绝而非卡住。

### 5.3 递归防护

```
BRIDGE_DEPTH 环境变量:
  0 → 正常允许委托
  1 → 允许被委托的 agent 工作，但禁止再次委托
  ≥2 → MCP server 直接拒绝启动
```

MCP server 启动时检查，spawn Claude 时传 `BRIDGE_DEPTH + 1`。

### 5.4 cwd 校验

```ts
validateCwd(raw):
  1. realpath 解析（防 ../ 越界）
  2. 必须在 ALLOW_ROOTS 白名单内
  3. 必须是目录
  4. implement 额外要求是 git 仓库
```

### 5.5 环境变量清理

只透传 `PATH, HOME, SHELL, LANG, LC_ALL, TERM, USER, TMPDIR, TEMP, TMP, NODE_ENV`。

过滤所有含 `SECRET, TOKEN, CREDENTIAL, PASSWORD, API_KEY` 的变量。

显式移除：`OPENAI_API_KEY, ANTHROPIC_API_KEY, GITHUB_TOKEN, GH_TOKEN, AWS_*, CLOUDFLARE_API_TOKEN, DOCKER_PASSWORD, NPM_TOKEN, SSH_AUTH_SOCK, SSH_AGENT_PID`。

### 5.6 命令行注入防护

**禁止** shell 字符串拼接：

```ts
// WRONG
exec(`claude -p -w ${name} --json-schema '${schema}' "${prompt}"`)

// CORRECT
spawn("claude", ["-p", "-w", name, "--json-schema", JSON.stringify(schema), prompt])
```

### 5.7 stdout 保护

MCP server 使用 stdio transport，stdout 用于 MCP JSON-RPC 协议。所有日志写 `process.stderr` 或文件。

### 5.8 server_observed 验证

不信任 Claude 自述的 `changed_files` 和测试结果。MCP server 在 Claude 完成后自己跑 `git diff --name-only` + `git diff --stat` 获取真实变更。

## 6. Prompt 注入约束

传给 Claude 的 prompt 中强制注入：

```text
- You are a worker delegated by Codex. Do NOT call Codex or any Codex-related tools.
- Do not delegate this task to another agent. Complete it yourself.
- Work exclusively within the provided worktree.
- After making changes, run the project's tests if available.
```

## 7. 开发阶段

### Phase 1（当前）：裸 MCP server，one-shot 委托 ✅

- [x] 独立 Node.js MCP server
- [x] 4 个 tool：status, query, review, implement
- [x] `claude -p` + `-w` + `--json-schema` + `--permission-mode dontAsk`
- [x] 安全措施全部到位
- [x] 日志写 stderr
- [x] server_observed 验证
- [ ] 在 Codex 中实际跑通 `claude_status` → `claude_query` → `claude_implement` 全链路

### Phase 2：会话复用

- Session store：`.codex-claude-delegate/sessions.json`
- 按 `repo + task_type` 映射 session_id
- 后续同类任务用 `claude -r <session_id>` 续接上下文
- 冷启动成本降低

### Phase 3：隔离增强 + 结果 apply

- worktree 的生命周期管理（创建 / 清理 / 垃圾回收）
- Codex 验收 diff 后的一键 apply 流程
- 超时和资源限制细化

### Phase 4：打包为 Codex Plugin

```
.codex-plugin/
├── plugin.json
├── skills/
│   ├── claude-delegate.md
│   ├── claude-review.md
│   └── claude-rescue.md
├── mcp-server/
│   └── (当前项目)
└── hooks/
    └── hooks.json
```

## 8. 已知限制

1. **无实时双向通信**：Codex 不能中途给 Claude 发补充指令，只能等 Claude 跑完
2. **Claude 无等价 App Server**：没有 Codex 那样的 JSON-RPC 守护进程，每次都是新进程
3. **worktree 清理**：Phase 1 不自动清理 worktree，需手动 `git worktree prune`
4. **session 不复用**：Phase 1 每次 one-shot，冷启动开销 ~2-5s
5. **Codex Plugin 未打包**：Phase 1 需手动配置 `~/.codex/config.toml`

## 9. Codex 配置示例

```toml
# ~/.codex/config.toml

[mcp_servers.claude_delegate]
command = "node"
args = ["/Users/anyi/codex-claude/dist/server.js"]
tool_timeout_sec = 600
startup_timeout_sec = 20
enabled_tools = ["claude_status", "claude_query", "claude_review", "claude_implement"]
```

## 10. 运行日志

运行日志写入 `.codex-claude-delegate/runs/<runId>.json`，包含：

- 请求参数
- Claude 返回的 structured_output
- server_observed（git diff 实际结果）
- 耗时
- 错误信息（如有）
