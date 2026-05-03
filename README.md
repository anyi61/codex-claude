# codex-claude-delegate-mcp

MCP 服务器，让 Codex CLI 可以把查询、审查和实现任务委托给 Claude Code。Codex 负责规划与验收；Claude 通过 `claude -p` 在受控权限和隔离 worktree 中执行。

当前状态：Phase 1-4 已完成并通过全工具链验收，包括 one-shot 委托、query 会话复用、apply/cleanup、资源控制、sandbox/network diagnostics 和 repo-local Codex plugin 打包。

## 工作原理

```text
Codex CLI
  -> MCP tool: claude_query / claude_review / claude_implement / claude_apply
  -> codex-claude-delegate-mcp (stdio)
  -> spawn("claude", args[]) with sanitized env and tool restrictions
  -> Claude Code returns structured JSON
  -> Codex reviews, applies, or cleans up worktrees
```

## 工具

| 工具 | 模式 | 作用 |
|---|---|---|
| `claude_status` | 只读 | 检查 Claude/Git/worktree/残留 delegated worktree 状态 |
| `claude_query` | 只读 | 向 Claude 提问；同 repo query 会话 20 分钟内自动复用 |
| `claude_review` | 只读 | 审查 diff 或指定文件；禁用 session persistence |
| `claude_implement` | 写入 worktree | 在隔离 worktree 中实现任务，支持 `session_key`、`max_cost_usd`、`max_changed_files` |
| `claude_apply` | 写入主工作区 | 将 delegated worktree 中的 `src/` 变更安全应用到主工作区 |
| `claude_cleanup` | worktree 管理 | dry-run 或清理 `.claude/worktrees/codex-delegated-*` |

## 设置

### 1. 前置条件

- Node.js >= 20
- Claude Code CLI 已安装，且 `claude` 在 `PATH` 中
- Codex CLI 已安装
- Git 仓库，`claude_implement` 依赖 `git worktree`

### 2. 安装

```bash
cd /path/to/codex-claude-delegate-mcp
npm install
npm run build
```

### 3. 直接配置 MCP

添加到 `~/.codex/config.toml`：

```toml
[mcp_servers.claude_delegate]
command = "node"
args = ["/path/to/codex-claude-delegate-mcp/dist/server.js"]
tool_timeout_sec = 600
startup_timeout_sec = 20
enabled_tools = ["claude_status", "claude_query", "claude_review", "claude_implement", "claude_apply", "claude_cleanup"]
```

### 4. 使用 Codex Plugin

Repo-local 插件位于：

```text
plugins/codex-claude-delegate/
```

插件 marketplace 位于：

```text
.agents/plugins/marketplace.json
```

插件的 `.mcp.json` 指向仓库构建产物 `dist/server.js`，所以使用插件前仍需先运行 `npm run build`。

### 5. 配置允许的根目录

默认只允许 `~/projects`、`~/work` 和 `~/codex-claude`。要扩展：

```toml
# ~/.codex/config.toml
[shell_environment_policy.set]
CODEX_CLAUDE_ALLOW_ROOTS = "/Users/you/projects:/Users/you/work:/Users/you/my-repo"
```

也可在 shell 中设置：

```bash
export CODEX_CLAUDE_ALLOW_ROOTS="/Users/you/projects:/Users/you/work"
```

## 使用流程

### 1. 检查环境

先确认 Claude CLI、认证、Git 和 worktree 状态：

```json
{
  "cwd": "/path/to/repo"
}
```

调用 `claude_status` 后重点看：

- `claude_available` 和 `auth_status`
- `cwd_valid` 和 `cwd_is_git_repo`
- `delegated_worktrees_count` 和 `stale_worktrees_count`

### 2. 只读提问

适合架构理解、代码定位、方案比较：

```json
{
  "task": "Explain how authentication is implemented in this repo.",
  "cwd": "/path/to/repo",
  "timeout_sec": 120
}
```

`claude_query` 会自动复用最近 20 分钟内同 repo 的 query session。不要用它要求 Claude 修改文件。

### 3. 只读审查

适合复杂 diff、安全敏感代码或 `claude_implement` 后的二次审查：

```json
{
  "task": "Review this diff for correctness, regressions, and security risks.",
  "cwd": "/path/to/repo",
  "diff": "<optional diff text>",
  "files": ["src/server.ts", "src/guard.ts"],
  "timeout_sec": 180
}
```

`claude_review` 不写文件，也不持久化 session。

### 4. 委托实现

适合多文件重构、风险较高或需要 Claude 独立执行的任务：

```json
{
  "task": "Add input validation for the new API path and update related types.",
  "cwd": "/path/to/repo",
  "files": ["src/server.ts", "src/schema.ts"],
  "constraints": ["Do not modify package.json", "Run npm run build"],
  "timeout_sec": 600,
  "max_cost_usd": 1,
  "max_changed_files": 5
}
```

返回结果包含：

- `claude_report`: Claude 自述的状态、摘要、测试和风险。
- `server_observed`: 服务端实际观测到的 changed files、diff stat、worktree path。
- `server_observed.resource_limits`: 文件数超限或预算参数记录。

`claude_implement` 默认不复用 implement session。如需显式续接：

```json
{
  "task": "Continue the previous implementation and fix the build error.",
  "cwd": "/path/to/repo",
  "session_key": "<claude-session-id>",
  "fork_session": true
}
```

`fork_session` 必须和 `session_key` 一起使用。

### 5. 审查并应用结果

`claude_implement` 不会修改主工作区。确认 `server_observed.worktree_path` 后，再调用 `claude_apply`：

```json
{
  "cwd": "/path/to/repo",
  "worktree_path": ".claude/worktrees/codex-delegated-xxxxxxxx",
  "cleanup": true
}
```

重要限制：

- `claude_apply` 只应用 worktree 中 `src/` 下的 `A/M/D` 文件变更，包括未跟踪的新增 `src/` 文件。
- 如果主工作区相关文件有未提交改动，会全量拒绝，不做部分 apply。
- `cleanup: true` 只在 apply 成功后移除对应 worktree。
- `dist/`、文档或其他目录不会被 apply；需要时请手动审查处理或重新设计任务。

### 6. 清理残留 worktree

先 dry-run：

```json
{
  "cwd": "/path/to/repo",
  "older_than_hours": 0,
  "dry_run": true
}
```

确认后清理：

```json
{
  "cwd": "/path/to/repo",
  "older_than_hours": 0,
  "dry_run": false
}
```

`claude_cleanup` 只处理 `.claude/worktrees/codex-delegated-*`，不会删除其他 worktree。

## 典型闭环

```text
1. claude_status
2. claude_implement with max_cost_usd + max_changed_files
3. inspect claude_report + server_observed
4. claude_review on the returned worktree/diff if risky
5. claude_apply with cleanup=true
6. npm run build or project-specific tests
7. claude_status to confirm delegated_worktrees_count
```

如果 `max_changed_files` 超限，优先拆小任务或先 `claude_review`，不要直接 apply。

## 故障处理

- `cwd outside allowed roots`：设置 `CODEX_CLAUDE_ALLOW_ROOTS`，并重启 Codex/MCP server。
- `claude CLI not found`：确认 `claude --version` 在同一 shell 环境可运行，或设置 `CLAUDE_BIN`。
- `fork_session requires session_key`：`fork_session` 只能配合显式 `session_key` 使用。
- `apply refused`：主工作区有本地改动。先提交、stash 或还原相关文件，再重试。
- `No changed source files found`：worktree 没有 `src/` 下的 A/M/D 变更；`claude_apply` 不处理文档、dist 或根目录文件。
- 残留 worktree：先 `claude_cleanup` dry-run，再 `dry_run: false` 清理。

## 安全

- 使用 `spawn("claude", args[])`，不拼接 shell 字符串。
- `--tools` 限制 Claude 可见工具，`--allowedTools` 自动审批安全调用，`--disallowedTools` 硬阻止危险命令。
- `--permission-mode dontAsk` 避免非交互模式卡住。
- `sanitizeEnv()` 移除 token、API key、SSH agent 等敏感环境变量。
- `BRIDGE_DEPTH` 防止 Codex -> Claude -> Codex 递归委托。
- `validateCwd()` 使用 realpath 和 allow roots 校验路径。
- `claude_apply` 遇到主工作区本地改动会全量拒绝，不做部分 apply。
- `claude_apply` 从 `git diff --name-status`、`git diff HEAD~1 --name-status` 和 `git status --short -- src/` 合并变更，避免漏掉未跟踪新增文件。

## 架构

```text
src/
├── server.ts       # MCP stdio 入口，注册 6 个工具
├── claude-cli.ts   # Claude CLI spawn、session、apply/cleanup、资源控制
├── guard.ts        # cwd 校验、环境清理、递归防护、exec helper
├── schema.ts       # 类型、JSON schema、prompt 构建器
└── session.ts      # sessions.json 读写、query auto-resume、prune
```

## 开发与验证

```bash
npm run dev                  # 用 tsx 运行源码
npm run build                # 编译 TypeScript 到 dist/
npm start                    # 运行 dist/server.js
npx tsx debug/mcp-test.ts    # MCP status/query/session 复用验证
npx tsx debug/test-implement.ts  # implement/resource_limits 验证
```

完整工具链验收应覆盖：

```text
claude_status -> claude_query -> claude_review -> claude_implement
  -> claude_apply(cleanup=true) -> claude_cleanup -> final claude_status
```

当前基准场景：`claude_query` 统计 `src/` + `debug/` 下 TypeScript 文件应返回 `7`；`claude_apply` 应能应用 `src/__delegate_full_flow_probe.ts` 这类未跟踪新增文件，并在测试后清理该探针文件。
