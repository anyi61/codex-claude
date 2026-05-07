# codex-claude-delegate-mcp

MCP 服务器，让 Codex CLI 可以把查询、审查和实现任务委托给 Claude Code。Claude 在隔离的 git worktree 中执行，Codex 负责规划与验收。

## 工作原理

```
Codex CLI → MCP tool → codex-claude-delegate-mcp (stdio)
  → spawn("claude", args[]) with sanitized env and tool restrictions
  → Claude Code returns structured JSON
  → Codex reviews, applies, or cleans up worktrees
```

执行型入口默认快速返回后台 `job_id`，避免 Codex 单次 tool call 等待 Claude 子进程过久。拿到 `job_id` 后通过 `claude_job_wait` 轮询。

## 前置条件

- Node.js >= 20
- Claude Code CLI，且 `claude` 在 `PATH` 中
- Codex CLI
- Git 仓库（implement 依赖 `git worktree`）

## 快速开始

```bash
cd /path/to/codex-claude-delegate-mcp
npm install
npm run build
```

添加 MCP 配置到 `~/.codex/config.toml`：

```toml
[mcp_servers.claude_delegate]
command = "node"
args = ["/absolute/path/to/dist/server.js"]
tool_timeout_sec = 600
startup_timeout_sec = 20
enabled_tools = [
  "claude_setup",
  "claude_task",
  "claude_job_wait",
  "claude_result",
  "claude_apply",
  "claude_cleanup"
]
```

启用即用。Codex 会自动加载 MCP 工具。

## 默认工作流

```
claude_setup → claude_task → claude_job_wait → claude_result
  → claude_apply preview=true → claude_apply cleanup=true → claude_cleanup
```

### 说明

- **claude_task** — 推荐的高层入口，自动路由到 read/review/write。给 `instruction_files` 传规划或需求文件（不是修改范围限制）。`files` 已废弃，会被当作 `instruction_files` 处理。
- **claude_job_wait** — 轮询 job 状态。非终态返回 `waiting=true`、`recommended_delay_ms`、`stale_state`。过早轮询返回 `poll_too_soon=true` + `next_allowed_poll_at`。不要在 `waiting=true` 时本地重复执行或另起 job。
- **claude_result** — 取当前工作区最相关的已完成结果，附带 `next_actions` 引导。
- **claude_apply** — 预览或合并 worktree 变更到主工作区。`scope_exceeded` 或 `changed_files_exceeded` 时会拒绝 apply。
- **claude_cleanup** — 清理 `.claude/worktrees/codex-delegated-*`，默认 dry-run。

### 默认 vs 高级工具

| 分类 | 工具 |
|------|------|
| Default（6 个，默认启用） | `claude_setup`, `claude_task`, `claude_job_wait`, `claude_result`, `claude_apply`, `claude_cleanup` |
| Advanced/Debug（12 个，默认禁用） | `claude_status`, `claude_runs`, `claude_run_inspect`, `claude_workspace_status`, `claude_review_gate`, `claude_query`, `claude_review`, `claude_implement`, `claude_jobs`, `claude_job_result`, `claude_job_cancel`, `claude_job_cleanup` |

普通任务用 `claude_task`，不要直接调 `claude_query`/`claude_review`/`claude_implement`。普通轮询用 `claude_job_wait`/`claude_result`，不要直接调 `claude_jobs`/`claude_job_result`/`claude_runs`。

## 配置允许的根目录

默认只允许 `~/projects`、`~/work`、`~/codex-claude`。扩展：

```toml
# ~/.codex/config.toml
[mcp_servers.claude_delegate.env]
CODEX_CLAUDE_ALLOW_ROOTS = "/Users/you/projects:/Users/you/work:/Users/you/my-repo"
```

也可在 shell 中设置 `export CODEX_CLAUDE_ALLOW_ROOTS="..."`。

## 关于 files 参数

- `claude_task.files` — 已废弃，按 `instruction_files` 处理（仅作上下文，不影响 apply scope）。使用 `instruction_files` 替代。
- `claude_implement.files` — Advanced 严格范围能力。会影响 `scope_exceeded` 判定，apply 越界时拒绝。
- 用户未提交改动时默认返回 `needs_user`，可通过 `dirty_policy=committed|snapshot` 控制。

## 安全

- 使用 `spawn("claude", args[])`，不拼接 shell 字符串
- `--tools` + `--allowedTools` + `--disallowedTools` + `--permission-mode dontAsk` 三层控制
- `sanitizeEnv()` 移除 token、API key、SSH agent 等敏感变量
- `BRIDGE_DEPTH` 防止递归委托（≥2 拒绝）
- `validateCwd()` realpath + allow roots 白名单校验

## 已知限制

- 无实时双向通信 — Codex 不能中途补充指令
- 每次 Claude 调用冷启动 ~2-5s
- 不自动清理 worktree — 需 `claude_cleanup`
- 旧 job（此前创建的记录）无 fingerprint/heartbeat_at，stale 分类回退到 updated_at
- Stale 检测仅为建议，不自动取消/杀进程
- 默认 6 工具面由 Codex MCP `enabled_tools` 控制；server 实际注册全部 18 个
