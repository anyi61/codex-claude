# PRD: Codex-Claude 安装体验与首次使用流程优化

**日期:** 2026-05-09  
**状态:** Final PRD draft after Claude review  
**目标版本:** 0.2.x  
**适用项目:** `codex-claude-delegate-mcp`

## 1. 产品定位

`codex-claude-delegate-mcp` 是一个本地 MCP 工具，让 Codex 把读代码、审查、实现等任务委托给 Claude Code 执行。Codex 负责规划、调用、等待、验收、预览和最终落地；Claude Code 在隔离 git worktree 中执行具体分析或实现。

当前项目已经具备核心委托能力，但普通用户的首次路径仍偏开发者化：用户需要理解插件、MCP 配置、allow roots、工具分层、worktree 和后台 job。PRD 的目标不是增加更多底层能力，而是把首次安装和首次成功调用变成一条短路径。

目标体验从：

```text
开发者能配置后使用
```

提升为：

```text
普通 Codex 用户能快速安装、诊断、开始委托，并且知道每一步下一步该做什么
```

## 2. 核心体验目标

理想路径：

```bash
npm install -g codex-claude-delegate-mcp
codex-claude setup --write
codex-claude doctor
```

然后用户重启 Codex，在仓库中输入：

```text
请调用 claude_setup 检查当前仓库是否可以使用 Claude 委托。
```

第一次写任务时，用户可以输入：

```text
请用 claude_task 的 write 模式读取 PROJECT_EXPANSION_PLAN.md 并执行其中的计划。请把该文件作为 instruction_files，不要作为 files。任务完成后调用 claude_result 展示结果，再用 claude_apply preview=true 预览变更，应用前先让我确认。
```

用户不应该被要求：

```text
手动找 dist/server.js
手写复杂 TOML
理解全部 Advanced / Debug tools
理解 run / job / session / worktree 的内部区别
猜测是否安装成功
猜测 Codex 下一步应该调用哪个工具
在未预览 diff 前允许自动 apply
```

## 3. 产品原则

1. **默认路径短:** 默认暴露和文档引导只覆盖 5 个日常工具。
2. **诊断优先:** 安装后用户必须能通过一个命令知道 ready / not_ready / needs_setup / needs_attention。
3. **预览优先:** Claude 写任务只产出隔离 worktree，落地主工作区前必须先 preview。
4. **用户确认优先:** 非 preview 的 `claude_apply` 必须在用户明确批准后传 `confirmed_by_user=true`。
5. **高级能力后置:** `claude_query`、`claude_review`、`claude_implement`、run/job 调试工具只在高级文档中出现，不进入默认配置。
6. **不隐藏失败:** 每个错误输出必须包含问题、原因、修复方式和下一步。

## 4. 关键产品决策

| 决策 | 结论 | 理由 |
|---|---|---|
| 主命令名 | `codex-claude` | 短、好记、适合日常使用 |
| 无参数行为 | 启动 MCP server | 适配 Codex MCP `command = "codex-claude"` 的最短配置 |
| 显式 MCP 行为 | `codex-claude mcp` | 便于本地调试和文档说明 |
| setup 默认配置 | 只写 npm 全局安装配置 | 用户必须先通过 `npm install -g codex-claude-delegate-mcp` 安装；`setup --write` 写 `command="codex-claude"` |
| 默认工具数 | 5 个 | 降低误用概率，避免用户看到底层工具矩阵；`claude_job_wait` 仅保留为 Advanced / Recovery 兼容入口 |
| 是否自动改 Codex config | 允许，但默认不覆盖 | `--force` 才覆盖，并且必须备份 |
| stable launcher | P2 | 先验证 npm global install + setup/doctor 主路径 |
| interaction block | P0 | 默认 5 工具必须全部返回用户可读下一步，否则首次使用体验仍然断裂 |

## 5. 默认工具集

`setup --write` 和 `print-config` 默认只启用以下 5 个工具：

```toml
enabled_tools = [
  "claude_setup",
  "claude_task",
  "claude_result",
  "claude_apply",
  "claude_cleanup"
]
```

不能默认启用：

```text
claude_status
claude_runs
claude_run_inspect
claude_workspace_status
claude_review_gate
claude_query
claude_review
claude_implement
claude_jobs
claude_job_result
claude_job_cancel
claude_job_wait
claude_job_cleanup
```

这些工具只能在 Advanced / Debug / Recovery 文档中出现，或由用户显式启用。

## 6. 用户旅程

### 6.1 安装

用户动作：

```bash
npm install -g codex-claude-delegate-mcp
```

期望：

```bash
codex-claude --version
```

输出：

```text
codex-claude-delegate-mcp v0.2.0
```

说明：`codex-claude-delegate-mcp` 只作为 npm 包名和版本输出中的包名，不作为用户可执行命令。

验收标准：

| 场景 | 预期 |
|---|---|
| 全局安装后 | `codex-claude` 可执行 |
| `--version` | 输出包名和版本 |
| 无参数运行 | 启动 MCP server，不打印普通 CLI 帮助污染 stdio |
| `mcp` 子命令 | 启动 MCP server |

### 6.2 写入 Codex 配置

用户动作：

```bash
codex-claude setup --write
```

默认写入：

```text
~/.codex/config.toml
```

全局安装模式配置：

```toml
[mcp_servers.claude_delegate]
command = "codex-claude"
startup_timeout_sec = 20
tool_timeout_sec = 600
enabled_tools = [
  "claude_setup",
  "claude_task",
  "claude_result",
  "claude_apply",
  "claude_cleanup"
]
```

验收标准：

| 场景 | 预期 |
|---|---|
| config 不存在 | 自动创建 |
| config 存在但无 `claude_delegate` | 追加配置 |
| `claude_delegate` 已存在 | 默认不覆盖 |
| `--force` | 备份后覆盖 |
| `--allow-root` | 添加经过 realpath 解析的安全路径 |
| dangerous root | 拒绝 `/`、`/tmp`、`/etc`、`$HOME` |
| 写入后 | `doctor` 能识别配置 |
| 工具列表 | 默认只写 5 个工具 |

### 6.3 安装诊断

用户动作：

```bash
codex-claude doctor
```

成功输出：

```text
Codex-Claude doctor

✓ Node.js: v22.11.0 (>=20)
✓ Package: codex-claude-delegate-mcp v0.2.0
✓ Claude CLI: /opt/homebrew/bin/claude
✓ Claude version: 2.1.116
✓ Claude auth: logged in
✓ Git: git version 2.46.0
✓ Git worktree: supported
✓ Codex config: /Users/you/.codex/config.toml
✓ MCP server: claude_delegate configured
✓ Default tools: 6 enabled
✓ Allow roots: current repo allowed

Status: ready

Next step:
  Restart Codex CLI, then ask:
  "Use claude_setup to check this repository."
```

Claude CLI 缺失：

```text
Codex-Claude doctor

✓ Node.js: v22.11.0 (>=20)
✗ Claude CLI: not found
✓ Git: git version 2.46.0
✓ Codex config: /Users/you/.codex/config.toml
✓ MCP server: claude_delegate configured

Status: not_ready

Problem:
  Claude Code CLI is not available in PATH.

Fix:
  Install Claude Code CLI and make sure `claude` is available in PATH.
  Or set CLAUDE_BIN in your Codex MCP config.

Next step:
  Run `codex-claude doctor` again after fixing Claude CLI.
```

Claude CLI 未登录或不可用：

```text
Codex-Claude doctor

✓ Node.js: v22.11.0 (>=20)
✓ Claude CLI: /opt/homebrew/bin/claude
✗ Claude auth: not logged in
✓ Git: git version 2.46.0
✓ Codex config: /Users/you/.codex/config.toml
✓ MCP server: claude_delegate configured

Status: not_ready

Problem:
  Claude Code CLI is installed but not authenticated or cannot run non-interactively.

Fix:
  Run Claude Code CLI login/auth setup, then verify `claude` works in this shell.

Next step:
  Run `codex-claude doctor` again after authentication succeeds.
```

Codex 未配置：

```text
Codex-Claude doctor

✓ Node.js: v22.11.0 (>=20)
✓ Claude CLI: /opt/homebrew/bin/claude
✓ Git: git version 2.46.0
✗ MCP server: claude_delegate not configured

Status: needs_setup

Fix:
  Run:
    codex-claude setup --write
```

当前仓库不在 allow roots：

```text
Codex-Claude doctor

✓ Node.js: v22.11.0 (>=20)
✓ Claude CLI: /opt/homebrew/bin/claude
✓ Codex config: /Users/you/.codex/config.toml
! Allow roots: current repo is not included

Status: needs_attention

Problem:
  Codex-Claude refuses to operate outside CODEX_CLAUDE_ALLOW_ROOTS.

Fix:
  Run:
    codex-claude setup --write --allow-root "/Users/you/current-repo"

Next step:
  Restart Codex CLI, then run claude_setup again.
```

JSON 输出：

```bash
codex-claude doctor --json
```

```json
{
  "ready": false,
  "status": "needs_attention",
  "checks": {
    "node": { "ok": true, "version": "v22.11.0" },
    "package": { "ok": true, "name": "codex-claude-delegate-mcp", "version": "0.2.0" },
    "claude_cli": { "ok": true, "path": "/opt/homebrew/bin/claude", "version": "2.1.116", "authenticated": true },
    "git": { "ok": true, "version": "git version 2.46.0", "worktree": true },
    "codex_config": { "ok": true, "path": "/Users/you/.codex/config.toml" },
    "mcp_server": { "ok": true, "name": "claude_delegate" },
    "default_tools": { "ok": true, "enabled_count": 5 },
    "allow_roots": { "ok": false, "current_repo_allowed": false }
  },
  "warnings": ["Current repo is not included in CODEX_CLAUDE_ALLOW_ROOTS."],
  "next_step": "Run codex-claude setup --write --allow-root \"/Users/you/current-repo\"."
}
```

`doctor` 至少检查：

```text
Node.js >= 20
包版本
Claude Code CLI 是否存在
claude --version 是否可运行
Claude Code CLI 是否已登录或可执行非交互任务
Git 是否存在
git worktree 是否可用
Codex config 是否存在
claude_delegate 是否配置
默认 5 个工具是否启用
当前仓库是否在 allow roots 内
```

### 6.4 输出可复制配置

用户动作：

```bash
codex-claude print-config
```

默认输出 npm 全局安装配置：

支持参数：

```bash
codex-claude print-config
codex-claude print-config --source /path/to/repo
codex-claude print-config --project
```

默认输出：

```toml
[mcp_servers.claude_delegate]
command = "codex-claude"
startup_timeout_sec = 20
tool_timeout_sec = 600
enabled_tools = [
  "claude_setup",
  "claude_task",
  "claude_result",
  "claude_apply",
  "claude_cleanup"
]
```

`--source /path/to/repo` 输出：

```toml
[mcp_servers.claude_delegate]
command = "node"
args = ["/absolute/path/to/codex-claude/dist/cli.js"]
startup_timeout_sec = 20
tool_timeout_sec = 600
enabled_tools = [
  "claude_setup",
  "claude_task",
  "claude_result",
  "claude_apply",
  "claude_cleanup"
]
```

验收标准：

```text
输出是合法 TOML
默认只包含 5 个工具
包含 startup_timeout_sec 和 tool_timeout_sec
不包含 Advanced / Debug tools
不输出 token、key、HOME 外敏感路径或当前环境变量全集
```

### 6.5 Codex 内首次使用

`claude_setup` 的产品职责是告诉用户当前仓库是否 ready，以及失败时如何修复。它可以检查和提示是否启用了 review gate，以及当前 gate 是否可用，但不应强制用户安装或启用该 hook。review-gate 的写入或启停行为属于 Advanced / Debug 工具 `claude_review_gate`。当前实现还会检查 review-gate hook installability / gate state；输出中必须明确披露，不得把 hook 变更伪装成只读诊断。

用户输入:

```text
Use claude_setup to check this repository.
```

或：

```text
请调用 claude_setup 检查当前仓库是否可以使用 Claude 委托。
```

ready 输出应包含用户可读状态：

```json
{
  "status": "ready",
  "checks": {
    "cwd_allowed": true,
    "claude_available": true,
    "git_worktree_supported": true,
    "default_workflow_tools_enabled": true,
    "review_gate": "available"
  },
  "interaction": {
    "headline": "Claude delegation is ready.",
    "state": "ready",
    "next_step": "Use claude_task to delegate a read, review, or write task."
  }
}
```

not ready 输出应给修复命令：

```json
{
  "status": "needs_attention",
  "problem": "Current repository is outside CODEX_CLAUDE_ALLOW_ROOTS.",
  "fix": "Run: codex-claude setup --write --allow-root \"/Users/you/project\"",
  "interaction": {
    "headline": "Claude delegation needs setup.",
    "state": "needs_attention",
    "next_step": "Add this repo to allow roots, restart Codex, then run claude_setup again."
  }
}
```

验收标准：

```text
用户能明确知道是否 ready
失败时必须给修复命令
不要求用户读 raw JSON 才能理解下一步
```

### 6.6 首次委托任务

只读分析：

```text
Use claude_task to ask Claude to explain how authentication works in this repo.
```

Codex 应调用：

```json
{
  "cwd": "/path/to/repo",
  "mode": "read",
  "task": "Explain how authentication works in this repo."
}
```

期望返回：

```json
{
  "status": "queued",
  "job": {
    "job_id": "job_xxx",
    "type": "query",
    "status": "queued"
  },
  "do_not_start_duplicate_job": true,
  "interaction": {
    "headline": "Task delegated to Claude Code.",
    "state": "delegated_execution",
    "next_step": "Continue with claude_task(job_id=...) with this job_id."
  },
  "next_actions": [
    {
      "tool": "claude_task",
      "args": {
        "cwd": "/path/to/repo",
        "job_id": "job_xxx",
        "wait_strategy": "block",
        "wait_timeout_sec": 540
      }
    }
  ]
}
```

执行规划文件：

```text
请让 Claude 阅读 PROJECT_EXPANSION_PLAN.md，并按里面的计划实现。完成后先展示结果，不要直接应用。
```

首次 write demo 的验收重点是流程走通：delegate write -> wait -> result -> preview -> 用户确认 -> apply。任务内容应尽量小，例如更新一个临时文档段落或 fixture 文本；不要求验证复杂业务结果。

Codex 应调用：

```json
{
  "cwd": "/path/to/repo",
  "mode": "write",
  "task": "Read PROJECT_EXPANSION_PLAN.md and implement the plan. Keep changes minimal and run tests if possible.",
  "instruction_files": ["PROJECT_EXPANSION_PLAN.md"]
}
```

必须避免：

```json
{
  "files": ["PROJECT_EXPANSION_PLAN.md"]
}
```

原因：`claude_task.files` 已废弃，只作为上下文兼容字段，不表示 apply 范围。计划文件必须放入 `instruction_files`。

期望返回：

```json
{
  "status": "queued",
  "job": {
    "job_id": "job_xxx",
    "type": "implement",
    "status": "queued"
  },
  "do_not_start_duplicate_job": true,
  "interaction": {
    "headline": "Implementation task delegated to Claude Code.",
    "state": "delegated_execution",
    "route_label": "[Codex-Claude] mode=write worker=claude-code",
    "next_step": "Continue with claude_task(job_id=...). Do not start a duplicate task."
  }
}
```

### 6.7 继续等待同一任务

Codex 调用：

```json
{
  "cwd": "/path/to/repo",
  "job_id": "job_xxx",
  "wait_strategy": "block",
  "wait_timeout_sec": 540
}
```

正常等待：

```json
{
  "waiting": true,
  "do_not_start_duplicate_job": true,
  "stale_state": "fresh",
  "wait": {
    "mode": "block",
    "timeout_sec": 540,
    "completed_inline": false,
    "waiting": true,
    "timed_out": true,
    "do_not_start_duplicate_job": true,
    "continuation_tool": "claude_task"
  },
  "next_actions": [
    {
      "tool": "claude_task",
      "args": {
        "cwd": "/path/to/repo",
        "job_id": "job_xxx",
        "wait_strategy": "block",
        "wait_timeout_sec": 540
      }
    }
  ],
  "interaction": {
    "headline": "Claude job is still running.",
    "state": "waiting",
    "next_step": "Continue this same job with claude_task(job_id=...). Do not start a duplicate task."
  }
}
```

stale：

```json
{
  "waiting": true,
  "stale_state": "stale",
  "do_not_start_duplicate_job": true,
  "next_actions": [
    {
      "tool": "claude_result",
      "args": { "cwd": "/path/to/repo", "job_id": "job_xxx" }
    }
  ],
  "interaction": {
    "headline": "Claude job appears stale.",
    "state": "needs_attention",
    "next_step": "Inspect this job result before starting a replacement. If Advanced / Debug tools are enabled, claude_job_cancel may be used manually."
  }
}
```

验收标准：

```text
running job 必须明确 do_not_start_duplicate_job=true
next_actions 必须始终包含同一个 cwd 和 job_id，并通过 claude_task(job_id=...) 继续等待
stale 状态不能继续建议无限 wait
stale 状态的默认 next_actions 不得引用默认 5 工具之外的工具
```

### 6.8 查看结果

Codex 调用：

```json
{
  "cwd": "/path/to/repo",
  "job_id": "job_xxx"
}
```

implement 成功：

```json
{
  "status": "success",
  "result_status": "success",
  "summary": "Claude implemented the requested plan.",
  "server_observed": {
    "worktree_path": ".claude/worktrees/codex-delegated-xxx",
    "changed_files": [
      "src/example.ts",
      "tests/example.test.ts",
      "README.md"
    ],
    "diff_stat": "..."
  },
  "next_actions": [
    {
      "tool": "claude_apply",
      "args": {
        "cwd": "/path/to/repo",
        "worktree_path": ".claude/worktrees/codex-delegated-xxx",
        "preview": true
      }
    }
  ],
  "interaction": {
    "headline": "Claude result is ready.",
    "state": "result_ready",
    "next_step": "Preview the worktree changes with claude_apply preview=true."
  }
}
```

验收标准：

```text
结果必须告诉用户改了哪些文件
必须告诉下一步是 preview，不是直接 apply
必须暴露 worktree_path
next_actions 不得包含非 preview apply
```

### 6.9 预览和应用

预览调用：

```json
{
  "cwd": "/path/to/repo",
  "worktree_path": ".claude/worktrees/codex-delegated-xxx",
  "preview": true
}
```

返回：

```json
{
  "preview": true,
  "planned_changes": [
    { "status": "M", "file": "src/example.ts" },
    { "status": "A", "file": "tests/example.test.ts" }
  ],
  "interaction": {
    "headline": "Delegated changes are ready for review.",
    "state": "apply_preview",
    "next_step": "Review planned_changes. If safe, ask the user whether to apply these changes."
  }
}
```

应用前必须先获得用户明确确认。确认后 Codex 才能调用：

```json
{
  "cwd": "/path/to/repo",
  "worktree_path": ".claude/worktrees/codex-delegated-xxx",
  "cleanup": true,
  "confirmed_by_user": true
}
```

返回：

```json
{
  "applied": true,
  "applied_files": [
    "src/example.ts",
    "tests/example.test.ts"
  ],
  "cleaned": true,
  "interaction": {
    "headline": "Delegated changes applied.",
    "state": "applied",
    "next_step": "Run project tests and review the final diff."
  }
}
```

缺少确认时拒绝（该校验必须在服务端 `runClaudeApply` 中强制执行，不能只依赖文档或模型自律）：

```json
{
  "applied": false,
  "error": "Non-preview claude_apply requires confirmed_by_user=true after the user explicitly approves applying the previewed diff.",
  "interaction": {
    "headline": "Apply refused.",
    "state": "needs_user",
    "next_step": "Show the preview to the user and ask for explicit approval before applying."
  }
}
```

非法组合（现有 Zod schema refinement 已覆盖，后续实现需保持）：

```json
{
  "cwd": "/path/to/repo",
  "worktree_path": ".claude/worktrees/codex-delegated-xxx",
  "preview": true,
  "cleanup": true
}
```

必须被拒绝，因为 preview 不应删除 worktree。

验收标准：

```text
preview 不修改主工作区
preview 不需要 confirmed_by_user
preview=true + cleanup=true 被拒绝
非 preview apply 必须要求 confirmed_by_user=true
apply 前用户能看到 planned_changes
cleanup=true 只在成功 apply 后清理 worktree
apply 失败或被拒绝时不得清理 worktree
被拒绝时给出可理解原因和下一步
```

### 6.10 清理 delegated worktree

预览清理调用：

```json
{
  "cwd": "/path/to/repo",
  "dry_run": true
}
```

返回：

```json
{
  "dry_run": true,
  "removed_count": 0,
  "failed_count": 0,
  "entries": [
    {
      "worktree_name": "codex-delegated-xxx",
      "removed": false
    }
  ],
  "interaction": {
    "headline": "Delegated worktrees found.",
    "state": "cleanup_preview",
    "next_step": "Review entries. If these worktrees are no longer needed, call claude_cleanup with dry_run=false."
  }
}
```

执行清理调用：

```json
{
  "cwd": "/path/to/repo",
  "dry_run": false,
  "older_than_hours": 0
}
```

返回：

```json
{
  "dry_run": false,
  "removed_count": 1,
  "failed_count": 0,
  "entries": [
    {
      "worktree_name": "codex-delegated-xxx",
      "removed": true
    }
  ],
  "interaction": {
    "headline": "Delegated worktrees cleaned.",
    "state": "cleaned",
    "next_step": "Run claude_cleanup dry_run=true again only if you want to confirm no stale delegated worktrees remain."
  }
}
```

验收标准：

```text
claude_cleanup 默认 dry_run=true
预览清理必须告诉用户将处理哪些 worktree
执行清理必须返回 removed_count、failed_count 和 entries
失败项必须保留 error 原因
interaction block 必须覆盖 dry-run 和实际清理两种路径
```

## 7. 优先级排序

### P0: npm 全局安装入口与 CLI

目标：用户通过 npm 全局安装，不 clone 仓库即可运行。

需求：

```text
新增 src/cli.ts
package.json 增加 bin，且只映射 `codex-claude` 到 `./dist/cli.js`
只支持 codex-claude 一个用户命令
普通用户必须通过 npm 全局安装，不提供 npx 临时运行路径
无参数默认启动 MCP server
支持 mcp 子命令显式启动 MCP server
--version 输出版本
package.json 增加 files、engines、prepublishOnly
```

验收：

```bash
npm run build
node dist/cli.js --version
node dist/cli.js mcp
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke","version":"0.0.0"}}}\n' | node dist/cli.js
# Expected: a valid JSON-RPC initialize response
```

### P0: setup --write / setup --print

目标：用户不手动编辑 `~/.codex/config.toml`。

需求：

```text
写入全局 Codex config
支持 setup --print 查看将写入内容
默认不覆盖已有 claude_delegate
--force 备份后覆盖
--allow-root 添加当前或指定仓库到 allow roots
默认只启用 5 个工具
写入后给出 next steps
```

验收：

```bash
codex-claude setup --print
codex-claude setup --write
codex-claude setup --write --force
codex-claude setup --write --allow-root "$(pwd)"
codex-claude doctor
```

### P0: doctor

目标：用户明确知道安装是否成功。

需求：

```text
检查 Node >= 20
检查包版本
检查 Claude CLI
检查 claude --version
检查 Claude CLI 鉴权状态
检查 Git
检查 Git worktree
检查 Codex config
检查 claude_delegate
检查默认 5 tools
检查 allow roots
支持 --json
```

验收：

```bash
codex-claude doctor
codex-claude doctor --json
```

### P0: print-config

目标：用户可以不自动写配置，只复制配置。

需求：

```text
输出 npm 全局安装配置
输出 source 模式配置
默认只启用 5 个工具
支持 --project 输出项目级配置路径说明
```

验收：

```bash
codex-claude print-config
codex-claude print-config --source /path/to/repo
```

### P0: README 安装路径重写

目标：README 第一屏让用户知道怎么安装、怎么检查、怎么开始。

需求：

```text
Quick Start
Install
Setup
Doctor
Ready means
One Message To Codex
60-Second Demo
Troubleshooting
Advanced / Debug tools 后置
```

验收：

```text
新用户只读 README 前 2 分钟，可以理解安装、诊断、首次调用和 apply 前确认流程
```

### P0: 发布配置

目标：npm 包可发布、可安装、可运行。

需求：

```text
package.json files 只包含 dist、README、LICENSE、必要插件文档
prepublishOnly 至少运行 build、typecheck、test、check:plugin 或等价发布检查
engines.node >= 20
npm pack 后包内包含 dist/cli.js 和 dist/server.js
```

验收：

```bash
npm pack
npm install -g ./codex-claude-delegate-mcp-*.tgz
codex-claude --version
codex-claude print-config
codex-claude doctor
```

### P1: setup --project

目标：支持项目级 Codex 配置。

需求：

```text
写入 ./.codex/config.toml
不覆盖已有配置
--force 备份
适合只在单仓库启用
```

验收：

```bash
codex-claude setup --write --project
codex-claude print-config --project
```

### P0: interaction block

目标：默认 5 工具返回用户可读状态，而不只是 JSON 数据。该能力是首次使用体验的一部分，必须覆盖全部默认 5 工具后才算完成。

需求：

给核心工具返回增加：

```json
{
  "interaction": {
    "headline": "...",
    "state": "...",
    "next_step": "..."
  }
}
```

覆盖工具：

```text
claude_setup
claude_task
claude_result
claude_apply
claude_cleanup
```

验收：

```text
用户看到工具返回时能理解当前发生了什么、是否还在等、下一步做什么、是否需要用户决定
```

### P1: Ready means / Verified Setup Flow

目标：用户知道什么叫装好了。

需求：

README、doctor 和 claude_setup 输出中明确：

```text
doctor ready
Codex config 已写
默认 5 tools 已启用
Claude CLI 可用
Git worktree 可用
当前 cwd 在 allow roots 内
claude_setup 可运行
```

验收：

```text
用户不需要读源码或 MCP raw schema 判断是否成功
```

### P0: 移除普通用户插件安装路径

目标：普通用户文档只展示 npm 全局安装路径，不再把 Codex plugin marketplace 作为用户安装路径。

需求：

```text
README 第一推荐且唯一普通用户安装路径为 npm 全局安装
普通用户文档不展示 codex plugin marketplace 安装流程
插件目录仅作为历史实现、内部兼容或维护者打包细节存在
开发文档如需提及插件 runtime，必须标注为非普通用户路径
```

验收：

```text
新用户不会被引导使用 Codex plugin 安装方式
README、Quick Start、Troubleshooting 都以 `npm install -g` 和 `codex-claude` CLI 为入口
```

### P2: stable launcher

目标：降低全局命令路径变化和未来入口迁移风险。

需求：

```text
写入 ~/.codex-claude/codex-claude-mcp.js
Codex config 可指向稳定 launcher
launcher 内记录实际包入口和版本
```

验收：

```text
移动源码仓库不影响 MCP 启动
用户可以通过 doctor 看到 launcher 是否有效
```

### P2: 本地配置目录

目标：集中管理用户配置。

需求：

```text
~/.codex-claude/config.json
保存 allowRoots、preferredInstallMode、lastDoctorResult、defaultTools
```

验收：

```text
setup 和 doctor 可读取该配置
配置损坏时 doctor 给出修复建议
```

### P2: MCP structured output 规范化

目标：让工具返回更符合 MCP structured result。

需求：

```text
默认 5 tools 增加 outputSchema
jsonResult 同时返回 text content 和 structuredContent
工具定义增加 title
必要时增加 annotations
```

验收：

```text
Codex 能继续读取结果
旧客户端仍能看到 text JSON
新客户端可读取 structuredContent
```

## 8. 命令设计总表

| 命令 | 优先级 | 用户价值 |
|---|---|---|
| `codex-claude --version` | P0 | 确认安装 |
| `codex-claude` | P0 | 作为 MCP server 默认入口 |
| `codex-claude mcp` | P0 | 显式启动 MCP server |
| `codex-claude print-config` | P0 | 手动配置用户可复制 |
| `codex-claude setup --print` | P0 | 查看将写入内容 |
| `codex-claude setup --write` | P0 | 自动配置 Codex |
| `codex-claude setup --write --force` | P0 | 修复已有错误配置 |
| `codex-claude setup --write --allow-root <path>` | P0 | 添加可信仓库根目录 |
| `codex-claude doctor` | P0 | 诊断安装 |
| `codex-claude doctor --json` | P0 | 自动化检查 |
| `codex-claude setup --write --project` | P1 | 项目级配置 |
| `codex-claude install --launcher` | P2 | 稳定 launcher |

## 9. Delegation Rules

适合委托给 Claude：

```text
局部功能实现
明确 bug 修复
单模块重构
测试补充
文档更新
执行规划文件
类型错误修复
lint 错误修复
小范围代码迁移
```

应留给 Codex 或用户决策：

```text
整体架构决策
安全模型修改
权限策略放宽
apply 审批
最终验收
Codex MCP 配置改动
跨模块高风险重构
生产部署操作
数据库迁移
密钥、认证、支付、权限相关变更
```

## 10. Troubleshooting 体验要求

每个错误必须给：

```text
问题
原因
修复命令
下一步
```

| 错误 | 用户看到的修复建议 |
|---|---|
| `claude command not found` | 安装 Claude Code CLI 或配置 `CLAUDE_BIN` |
| `cwd outside allowed roots` | `codex-claude setup --write --allow-root "$(pwd)"` |
| dangerous allow root | 使用具体仓库路径，不要使用 `/`、`/tmp`、`/etc` 或 `$HOME` |
| `waiting=true` | 使用 `claude_task(job_id=...)` 继续等待同一个 `job_id`，不要重复委托 |
| stale job | 先用默认工具 inspect 结果；如启用 Advanced / Debug tools，再考虑 cancel；不要直接开重复任务 |
| `apply refused: dirty workspace` | commit/stash，或重新选择合适的 dirty policy |
| missing `confirmed_by_user` | 先展示 preview，并让用户明确确认后再 apply |
| `preview=true` + `cleanup=true` | 拆成 preview 和用户确认后的 apply+cleanup 两步 |
| `scope_exceeded` | 检查是否误用了 Advanced `files` 或任务范围过宽 |
| leftover worktrees | `claude_cleanup(cwd="...", dry_run=true)` 预览后再 `dry_run=false` |

## 11. 发布验收标准

发布前验证命令由实现方执行，审查方只检查结果和 diff：

```bash
npm run build
npm test
npm run typecheck
npm run check:plugin
```

CLI 验收：

```bash
node dist/cli.js --version
node dist/cli.js print-config
node dist/cli.js setup --print
node dist/cli.js doctor
node dist/cli.js doctor --json
node dist/cli.js mcp
```

安装验收：

```bash
npm pack
npm install -g ./codex-claude-delegate-mcp-*.tgz
codex-claude --version
codex-claude print-config
codex-claude doctor
```

Codex 验收：

```text
1. setup --write
2. restart Codex
3. ask Codex to call claude_setup
4. ask Codex to run claude_task read
5. ask Codex to run claude_task write with instruction_files
6. continue the same job with claude_task(job_id=...)
7. inspect result with claude_result
8. preview with claude_apply preview=true
9. after explicit user approval, apply with cleanup=true confirmed_by_user=true
10. cleanup stale delegated worktrees with claude_cleanup dry-run first
```

## 12. 非目标

本 PRD 不要求：

```text
重写 Claude 执行沙箱
放宽 allow roots 安全策略
默认启用 Advanced / Debug tools
让 Claude 自动 apply
继续支持 Codex plugin marketplace 作为普通用户安装路径
提供 npx 临时运行安装路径
实现跨平台 GUI 安装器
实现 npm 发布自动化流水线
```

## 13. Claude 复审共识

本 PRD 已按 Claude 复审意见修正以下点：

```text
1. stale job 默认流程不再建议未启用的 claude_job_cancel。
2. claude_setup 的 readiness 职责与现有 review-gate 检查行为已显式说明。
3. print-config --source 不再把 mcp 子命令写入 Codex 配置，保持无参数即 MCP server 的最短路径。
4. doctor 增加 Claude CLI 鉴权状态检查，避免已安装但未登录时误报 ready。
5. interaction block 根据用户最终决策提升为 P0，必须覆盖默认 5 工具，包括 `claude_cleanup`。
6. setup --print、服务端 confirmed_by_user 校验、preview+cleanup schema 校验、apply 失败不清理 worktree 均已写入验收。
```

双方一致结论：PRD 方向成立；用户最终决策已进一步收敛为 npm 全局安装唯一普通用户路径。最终复审指出的 `claude_cleanup` 示例、global-bin 术语和插件路径优先级问题已修正。

## 14. 用户最终产品决策

1. 主命令只保留 `codex-claude`；`codex-claude-delegate-mcp` 只作为 npm 包名，不作为可执行命令别名。
2. `setup --write` 不再做安装模式自动选择；普通用户必须先全局安装，配置只写 `command = "codex-claude"`。
3. `--allow-root` 纳入 P0。
4. 普通用户文档只展示 npm 全局安装路径，不展示 npx 或 Codex plugin marketplace 安装路径；这些方式后续不再作为用户安装方式使用。
5. `interaction` block 必须覆盖默认 5 工具后才算完成。
6. 首次 write demo 只需要验证流程走通，不要求实现复杂或业务结果正确。
7. `claude_setup` 可以检查和提示 review gate 状态，但不强制安装或启用 hook；review-gate 写入或启停行为属于 Advanced / Debug 工具 `claude_review_gate`。
