# codex-claude-delegate-mcp

MCP 服务器，让 Codex CLI 可以把查询、审查和实现任务委托给 Claude Code。Codex 负责规划与验收；Claude 通过 `claude -p` 在受控权限和隔离 worktree 中执行。

当前状态：Phase 1-4 已完成并通过全工具链验收，包括 one-shot 委托、query 会话复用、apply/cleanup、资源控制、sandbox/network diagnostics 和 repo-local Codex plugin 打包。

## 工作原理

```text
Codex CLI
  -> MCP tool: claude_status / claude_setup / claude_runs / claude_run_inspect / claude_result / claude_workspace_status / claude_task / claude_review_gate / claude_query / claude_review / claude_implement / claude_jobs / claude_job_result / claude_job_cancel / claude_job_wait / claude_job_cleanup / claude_apply / claude_cleanup
  -> codex-claude-delegate-mcp (stdio)
  -> spawn("claude", args[]) with sanitized env and tool restrictions
  -> Claude Code returns structured JSON
  -> Codex reviews, applies, or cleans up worktrees
```

返回结果现在统一包含 `status`、`execution` 和 `warnings`。`execution` 记录 Claude CLI 的 `exit_code`、`duration_ms`、`timed_out`、截断后的 `stdout_tail` 和脱敏后的 `stderr_tail`，避免把完整日志塞进 MCP 响应。

## 工具

这 18 个工具可以按“入口、执行、检查、收尾”四类理解。日常优先用 `claude_task`、`claude_result` 和 `claude_workspace_status`，只有需要精确控制时再调用底层工具。

| 工具 | 何时使用 | 关键参数 |
|---|---|---|
| `claude_status` | 快速检查 Claude CLI、Git、worktree、允许根目录和残留状态 | `cwd` |
| `claude_setup` | 第一次接入或怀疑环境没配好时做完整就绪检查；也可显式把当前项目加入允许目录 | `cwd`, `configure_allow_root` |
| `claude_task` | 推荐的高层入口，让服务端自动或按模式委托 query/review/implement | `cwd`, `task`, `mode=auto/read/review/write`, `background` |
| `claude_query` | 只读问答、架构解释、代码定位；不会改文件 | `cwd`, `task`, `timeout_sec`, `background` |
| `claude_review` | 审查 diff 或文件风险；不会改文件 | `cwd`, `task`, `diff`, `files`, `background` |
| `claude_implement` | 让 Claude 在隔离 worktree 中改代码；不会直接改主工作区 | `cwd`, `task`, `files`, `constraints`, `max_changed_files`, `max_cost_usd`, `background` |
| `claude_result` | 不想记具体 run/job 时，直接取当前工作区最相关的完成结果 | `cwd`, `job_id`, `run_id`, `prefer` |
| `claude_workspace_status` | 看当前 repo 全局状态：后台任务、run、session、worktree 和待处理项 | `cwd`, `limit`, `include_terminal` |
| `claude_runs` | 列出历史 run log，用于追踪 query/review/implement/apply/cleanup | `cwd`, `type`, `status`, `limit` |
| `claude_run_inspect` | 按 run id 深入查看单次运行的原始记录和关联 apply/cleanup | `cwd`, `run_id` |
| `claude_jobs` | 列出后台任务 | `cwd`, `type`, `status`, `limit` |
| `claude_job_result` | 按 job id 读取后台任务结果 | `cwd`, `job_id` |
| `claude_job_wait` | 等后台任务进入终态，适合替代手写轮询 | `cwd`, `job_id`, `timeout_ms`, `poll_interval_ms` |
| `claude_job_cancel` | 取消自己启动的 queued/running 后台任务 | `cwd`, `job_id` |
| `claude_job_cleanup` | 清理当前仓库旧的终态后台任务记录，默认先 dry-run | `cwd`, `older_than_hours`, `dry_run`, `limit` |
| `claude_apply` | 预览或合并 delegated worktree 的变更到主工作区 | `cwd`, `worktree_path`, `preview`, `cleanup`, `background` |
| `claude_cleanup` | 清理 `.claude/worktrees/codex-delegated-*` worktree，默认 dry-run | `cwd`, `older_than_hours`, `dry_run`, `background` |
| `claude_review_gate` | 查询、启用或关闭 repo-local review gate | `cwd`, `action=status/enable/disable` |

常见闭环：

```text
只读分析：claude_task mode=read -> claude_result
代码审查：claude_review background=true -> claude_job_wait -> claude_result
代码实现：claude_implement -> claude_result -> claude_apply preview=true -> claude_apply cleanup=true -> claude_cleanup
```

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

工程验收命令：

```bash
npm run build
npm test
npm run typecheck
```

`npm test` 使用 Vitest。若本机尚未安装依赖，先运行 `npm install`。

### 3. 直接配置 MCP

添加到 `~/.codex/config.toml`：

```toml
[mcp_servers.claude_delegate]
command = "node"
args = ["/path/to/codex-claude-delegate-mcp/dist/server.js"]
tool_timeout_sec = 600
startup_timeout_sec = 20
enabled_tools = ["claude_status", "claude_setup", "claude_runs", "claude_run_inspect", "claude_result", "claude_workspace_status", "claude_task", "claude_review_gate", "claude_query", "claude_review", "claude_implement", "claude_jobs", "claude_job_result", "claude_job_cancel", "claude_job_wait", "claude_job_cleanup", "claude_apply", "claude_cleanup"]
```

如果你不需要限制工具，推荐直接省略 `enabled_tools`，让 Codex 自动读取 MCP server 暴露的完整工具列表。若保留 `enabled_tools`，必须包含上面全部 18 个工具；旧配置常只包含 `claude_status`、`claude_query`、`claude_review`、`claude_implement`、`claude_apply`、`claude_cleanup`，会导致后台任务、run 检查、review gate 和高层工作流工具不可用。

如果 `codex mcp get claude_delegate` 只显示 6 个工具，通常是旧白名单导致的。最简单修复方式是重建 MCP 配置并省略 `enabled_tools`：

```bash
codex mcp remove claude_delegate
codex mcp add claude_delegate -- node /path/to/codex-claude-delegate-mcp/dist/server.js
```

检查当前 Codex 配置实际暴露的工具：

```bash
codex mcp get claude_delegate
```

零成本检查 server 自身工具列表，不会调用 Claude：

```bash
npm run build
npx tsx debug/mcp-list-tools.ts
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
[mcp_servers.claude_delegate.env]
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
- `recent_runs.entries` 和 `recent_runs.lifecycle_counts`，用于查看最近委托活动摘要

### 2. 只读提问

在提问前，也可以先检查最近委托记录：

```json
{
  "cwd": "/path/to/repo",
  "type": "implement",
  "limit": 10
}
```

`claude_runs` 会返回近期 run log 摘要，可按 `type`、`status`、`worktree_name` 过滤。
对于 `implement` 记录，`lifecycle` 会在后续 `claude_apply` / `claude_cleanup` 成功后更新为 `applied` / `cleaned`，便于从单次委托视角查看闭环状态。

若已知某个 `run_id`，可进一步读取单条日志：

```json
{
  "cwd": "/path/to/repo",
  "run_id": "run-implement"
}
```

`claude_run_inspect` 会返回该 run 的规范化 `entry`、原始 `raw` 日志，以及关联的 `apply_run_id` / `cleanup_run_id`（如存在）。

### 3. 统一结果视图

如果你已经拿到了 `job_id`，或者只是想快速知道“这个仓库最近一次委托现在该做什么”，优先用 `claude_result`：

```json
{
  "cwd": "/path/to/repo",
  "job_id": "job-123"
}
```

也可以不传显式 id，而是让服务端按偏好帮你选最近结果：

```json
{
  "cwd": "/path/to/repo",
  "prefer": "latest-implement"
}
```

`claude_result` 会统一返回：

- `source_type`: 结果来自 background job 还是 run log
- `summary`: 当前最值得看的摘要
- `job` / `run`: 命中的底层记录
- `session`: 可续接的 Claude session 摘要
- `next_actions`: 建议的下一步，例如 `claude_apply`、`claude_cleanup`、`claude_implement resume_latest`

### 4. 工作区状态视图

如果你想回答“这个 repo 现在发生了什么”，优先用 `claude_workspace_status`：

```json
{
  "cwd": "/path/to/repo",
  "limit": 10,
  "include_terminal": true
}
```

它会在一个响应里聚合：

- `running_jobs` / `queued_jobs`
- `recent_terminal_jobs`
- `recent_runs`
- `latest_sessions`
- `delegated_worktrees`
- `counts`
- `attention_items`

适合替代手工拼 `claude_status`、`claude_jobs`、`claude_runs` 的多次查询。

### 5. 高层任务入口

如果你不想手动决定该用 `claude_query`、`claude_review` 还是 `claude_implement`，优先用 `claude_task`：

```json
{
  "cwd": "/path/to/repo",
  "task": "Explain how auth is wired in this repo.",
  "mode": "read",
  "background": true
}
```

也可以让服务端自己选型：

```json
{
  "cwd": "/path/to/repo",
  "task": "Review this patch for regressions.",
  "mode": "auto",
  "diff": "<optional diff text>",
  "background": true
}
```

`claude_task` 会返回：

- `delegated_mode`: 实际路由到 `read`、`review` 或 `write`
- `summary`: 当前调度摘要
- `job` 或 `result`
- `session`
- `next_actions`

经验上：

- `mode=read` 适合解释、分析、定位
- `mode=review` 适合 diff/风险审查
- `mode=write` 适合真实改代码
- `mode=auto` 会根据 `diff`、`constraints`、`files` 和任务措辞推断

### 6. Setup 与 Review Gate

在启用高层工作流前，先检查 workspace 是否准备好：

```json
{
  "cwd": "/path/to/repo"
}
```

`claude_setup` 会返回：

- `review_gate`
- `claude_available`
- `auth_status`
- `git_available`
- `worktree_capable`
- `next_steps`

如果当前项目还不在允许目录内，`claude_setup` 会返回结构化 `next_actions`，提示你用显式开关初始化当前目录：

```json
{
  "cwd": "/path/to/repo",
  "configure_allow_root": true
}
```

这会把该目录写入 `~/.codex/config.toml` 的 `[mcp_servers.claude_delegate.env] CODEX_CLAUDE_ALLOW_ROOTS`，并更新当前 MCP 进程环境，让后续工具调用在同一会话里也能继续使用。出于安全考虑，只有显式传 `configure_allow_root: true` 才会扩大允许目录；危险根目录如 `/`、`/tmp` 和用户 home 根目录仍会被拒绝。

`CODEX_CLAUDE_ALLOW_ROOTS` 推荐使用系统路径分隔符：macOS/Linux 使用 `:`，Windows 使用 `;`。为了兼容真实调试中常见的误配置，服务端也会容忍逗号分隔的旧值，并在下一次写配置时规范化为正确分隔符。

如需启用或关闭 review gate：

```json
{
  "cwd": "/path/to/repo",
  "action": "enable"
}
```

`claude_review_gate` 支持：

- `action=status`
- `action=enable`
- `action=disable`

启用后会：

- 在当前仓库写入 `.codex-claude-delegate/review-gate.json`
- 确保插件 stop-hook manifest 已存在
- 在后续 write-oriented 工作流后记录 `pending_review`

当前 review gate 已验证 MCP 层的 enable/status/disable、repo-local 状态、hook 脚本/资产准备，以及外部 Claude 插件运行时真实触发 `Stop` hook。Stop hook 只输出顶层 `systemMessage` 和诊断字段；不要在 Stop hook 输出中使用 `hookSpecificOutput`，Claude 2.1.116 会按非 Stop 事件 schema 校验该字段。

### 7. 只读提问

适合架构理解、代码定位、方案比较：

```json
{
  "task": "Explain how authentication is implemented in this repo.",
  "cwd": "/path/to/repo",
  "timeout_sec": 120
}
```

`claude_query` 会自动复用最近 20 分钟内同 repo 的 query session。不要用它要求 Claude 修改文件。

如需把只读分析放到后台执行：

```json
{
  "task": "Explain how the background job model works in this repo.",
  "cwd": "/path/to/repo",
  "background": true
}
```

### 8. 只读审查

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

如需后台执行并稍后轮询结果：

```json
{
  "task": "Review this diff for correctness and regressions.",
  "cwd": "/path/to/repo",
  "files": ["src/server.ts"],
  "background": true
}
```

拿到返回的 `job.job_id` 后，可以直接等待终态，而不是自己循环调用 `claude_job_result`：

```json
{
  "cwd": "/path/to/repo",
  "job_id": "<job-id>",
  "timeout_ms": 30000,
  "poll_interval_ms": 1000
}
```

`claude_job_wait` 会在任务变为 `succeeded`、`failed` 或 `cancelled` 时返回完整 job/result；超时则报错。

如果后台任务历史积累较多，可以先 dry-run 看看哪些终态任务会被清理：

```json
{
  "cwd": "/path/to/repo",
  "older_than_hours": 24,
  "dry_run": true,
  "limit": 20
}
```

确认后把 `dry_run` 改成 `false` 即可实际删除；`claude_job_cleanup` 只会处理当前仓库的终态任务记录，不会碰 `queued` / `running` 任务。

### 9. 委托实现

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
- `server_observed`: 服务端基于 worktree 创建基线（`base_commit`）观测到的 changed files、diff stat、worktree path。
- `server_observed.resource_limits`: 文件数超限或预算参数记录。
- `server_observed.scope`: 当传入 `files` 时，服务端会记录越界变更（`out_of_scope_files` / `scope_exceeded` / `warnings`）。

`files` 行为补充：

- `claude_implement` 在创建 worktree 前会检查 `files` 对应路径在主工作区是否 dirty（`git status --porcelain=v1 -z`）。
- 若存在未提交改动，会直接拒绝任务，避免“主工作区改动在新 worktree 丢失”的静默偏差。

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

如需后台实现：

```json
{
  "task": "Add input validation for the new API path and update related types.",
  "cwd": "/path/to/repo",
  "files": ["src/server.ts", "src/schema.ts"],
  "constraints": ["Run npm run build"],
  "background": true
}
```

后台实现同样可配合 `claude_job_wait` 使用；如果只想做非阻塞轮询，仍可继续使用 `claude_jobs` 和 `claude_job_result`。

如果只是继续当前仓库最近一次可续接的 implement session，可直接让服务端解析最近日志：

```json
{
  "task": "Continue the previous implementation and fix the build error.",
  "cwd": "/path/to/repo",
  "resume_latest": true
}
```

`resume_latest` 不能和 `session_key` 同时传入；解析不到可续接会话时会直接报错。

### 10. 审查并应用结果

`claude_implement` 不会修改主工作区。确认 `server_observed.worktree_path` 后，再调用 `claude_apply`：

```json
{
  "cwd": "/path/to/repo",
  "worktree_path": ".claude/worktrees/codex-delegated-xxxxxxxx",
  "cleanup": true,
  "preview": false
}
```

只想预览，不想修改主工作区时：

```json
{
  "cwd": "/path/to/repo",
  "worktree_path": ".claude/worktrees/codex-delegated-xxxxxxxx",
  "preview": true
}
```

preview 模式会返回 `planned_changes`，并保证主工作区不被修改。

如需把 apply 放到后台执行：

```json
{
  "cwd": "/path/to/repo",
  "worktree_path": ".claude/worktrees/codex-delegated-xxxxxxxx",
  "background": true
}
```

重要限制：

- `claude_apply` 优先应用 implement run log 中 `server_observed.changed_files` 记录的 `A/M/D` 文件变更，因此可处理请求范围内的文档、根目录文件和 `src/` 文件。
- `claude_apply` 会读取 implement run log；若 `scope_exceeded=true` 或 `changed_files_exceeded=true`，会拒绝 apply。
- `claude_apply` 变更识别优先使用 implement 记录的 `base_commit` 和 `server_observed.changed_files`，统一按 `base_commit..HEAD` + 未提交 + untracked 观测；缺少可信 implement log 时才回退到 legacy `src/` 路径。
- 如果主工作区相关文件有未提交改动，会全量拒绝，不做部分 apply。
- `claude_apply` 在 preview 模式下同样会执行范围校验、冲突检测和 planned changes 解析，但不会写入主工作区。
- `cleanup: true` 只在 apply 成功后移除对应 worktree。
- `dist/`、`.git/`、未被服务端观测记录的越界文件不会被 apply；需要时请重新设计任务并显式纳入 `files`。

### 11. 后台任务管理

后台任务状态持久化到：

```text
.codex-claude-delegate/jobs/
```

列出任务：

```json
{
  "cwd": "/path/to/repo",
  "limit": 10
}
```

读取单个任务结果：

```json
{
  "cwd": "/path/to/repo",
  "job_id": "job-123"
}
```

取消任务：

```json
{
  "cwd": "/path/to/repo",
  "job_id": "job-123"
}
```

推荐流程：

```text
1. claude_query / claude_review / claude_implement / claude_apply / claude_cleanup with background=true
2. claude_job_wait，或用 claude_jobs / claude_job_result 轮询状态
3. 必要时 claude_job_cancel
4. 周期性用 claude_job_cleanup 清理旧的终态任务记录
5. inspect result, then claude_apply / claude_cleanup
```

### 12. 清理残留 worktree

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

如需把 worktree cleanup 放到后台执行：

```json
{
  "cwd": "/path/to/repo",
  "older_than_hours": 24,
  "dry_run": false,
  "background": true
}
```

`claude_cleanup` 只处理 `.claude/worktrees/codex-delegated-*`，不会删除其他 worktree。

默认 `dry_run=true` 且 `older_than_hours=24`。建议先 dry run，确认结果已通过 `claude_apply` 落地或不再需要，再设置 `dry_run=false`。

运行日志默认写入：

```text
.codex-claude-delegate/runs/
```

可以通过 `CODEX_CLAUDE_RUN_LOG_DIR` 改到其他目录。日志写文件或 stderr，普通日志不会写 stdout，以免破坏 MCP stdio 协议。

## 典型闭环

```text
1. claude_status
2. claude_implement with max_cost_usd + max_changed_files
3. claude_runs or claude_run_inspect
4. claude_review on the returned worktree/diff if risky
5. claude_apply preview=true
6. claude_apply with cleanup=true
7. npm run build or project-specific tests
8. claude_status to confirm delegated_worktrees_count
```

如果 `max_changed_files` 超限，优先拆小任务或先 `claude_review`，不要直接 apply。

## 故障处理

- `claude command not found`: 安装 Claude Code CLI，或设置 `CLAUDE_BIN`。
- Codex 找不到 MCP server: 确认 `args` 使用构建后的绝对路径 `dist/server.js`，并已运行 `npm run build`。
- `permission denied`: 检查仓库、worktree 和日志目录权限。
- `cwd outside allowRoots`: 设置 `CODEX_CLAUDE_ALLOW_ROOTS`，不要硬编码危险根目录。
- JSON schema parse failed: 检查 Claude CLI 版本，并确认 `--json-schema` 仍是 prompt 前最后一个 flag。
- worktree remains after failed run: 先调用 `claude_cleanup` dry run，再选择是否清理。

## 已知限制

- 不做实时双向聊天。
- 不依赖 Claude Code Channels。
- 不自动清理所有 worktree。
- 不默认允许网络命令。
- 不默认透传 token 或完整 `process.env`。

- `cwd outside allowed roots`：设置 `CODEX_CLAUDE_ALLOW_ROOTS`，并重启 Codex/MCP server。
- `claude CLI not found`：确认 `claude --version` 在同一 shell 环境可运行，或设置 `CLAUDE_BIN`。
- `fork_session requires session_key`：`fork_session` 只能配合显式 `session_key` 使用。
- `apply refused`：主工作区有本地改动。先提交、stash 或还原相关文件，再重试。
- `Requested files contain uncommitted changes`：`claude_implement` 检测到 `files` 对应路径在主工作区 dirty。先提交/暂存/清理这些文件，再重试。
- `No changed files found`：worktree 中没有可根据 implement log 或 legacy fallback 识别的 A/M/D 变更。
- 残留 worktree：先 `claude_cleanup` dry-run，再 `dry_run: false` 清理。

## 安全

- 使用 `spawn("claude", args[])`，不拼接 shell 字符串。
- `--tools` 限制 Claude 可见工具，`--allowedTools` 自动审批安全调用，`--disallowedTools` 硬阻止危险命令。
- `--permission-mode dontAsk` 避免非交互模式卡住。
- `sanitizeEnv()` 移除 token、API key、SSH agent 等敏感环境变量。
- `BRIDGE_DEPTH` 防止 Codex -> Claude -> Codex 递归委托。
- `validateCwd()` 使用 realpath 和 allow roots 校验路径。
- `claude_apply` 遇到主工作区本地改动会全量拒绝，不做部分 apply。
- `claude_apply` 使用 `git diff --name-status -z` + `git status --porcelain=v1 -z` 解析变更，避免 `--short` 字符串切片误判路径。
- 可通过 `CODEX_CLAUDE_RUN_LOG_DIR` 覆盖 run log 目录（默认 `.codex-claude-delegate/runs`），便于隔离测试日志。

## 架构

```text
src/
├── server.ts       # MCP stdio 入口，注册 setup/result/workspace/task/review-gate/status/runs/query/review/implement/jobs/apply/cleanup 工具
├── claude-cli.ts   # Claude CLI spawn、session、background job 管理、apply/cleanup、资源控制
├── job-runner.ts   # detached background worker 入口
├── jobs.ts         # background job 持久化与取消辅助
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
npx tsx debug/test-review-gate-hook.ts  # 直接验证 review gate Stop hook 输出
npx tsx debug/test-claude-plugin-runtime.ts  # 验证外部 Claude 插件加载、hook 注册、MCP 连接
STRICT_STOP_HOOK=1 USE_REAL_CLAUDE_HOME=1 node --import tsx debug/test-claude-plugin-runtime.ts  # 在真实 Claude 环境断言 Stop hook 端到端触发
```

完整工具链验收应覆盖：

```text
claude_status -> claude_query -> claude_review -> claude_implement
  -> claude_apply(cleanup=true) -> claude_cleanup -> final claude_status
```

当前基准场景：`claude_query` 统计 `src/` + `debug/` 下 TypeScript 文件应返回 `7`；`claude_apply` 应能应用 `src/__delegate_full_flow_probe.ts` 这类未跟踪新增文件，并在测试后清理该探针文件。
