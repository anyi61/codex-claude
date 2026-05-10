# codex-claude-delegate-mcp

通过本地 MCP 服务器，让 Codex CLI 将读取、审查、写入任务委托给 Claude Code 执行。

## 快速开始

```bash
npm install -g @anyi61/codex-claude-delegate-mcp
codex-claude setup --write
codex-claude doctor
```

重启 Codex，然后输入：

```text
Use claude_setup to check this repository.
```

### 60 秒演示

```text
1. claude_setup                          → 检查工作区就绪状态
2. claude_task(mode="read", ...)         → 委托一个读取分析任务
3. claude_task(mode="write", ...)        → 委托一个写入任务（带 instruction_files）
4. claude_job_wait(...)                  → 轮询直到任务完成
5. claude_result(...)                    → 检查结果和修改的文件
6. claude_apply(preview=true, ...)       → 预览 diff
7. user approval                         → 用户确认
8. claude_apply(cleanup=true, ...)       → 应用变更并清理 worktree
9. claude_cleanup(dry_run=true, ...)     → 确认没有残留 worktree
```

## 功能特性

- **委托读取/审查/写入任务** — 从 Codex 到 Claude Code
- **隔离的 git worktree 执行** — 写入任务在独立的 worktree 中运行，不影响主工作区
- **后台任务轮询** — 所有委托排队为后台任务，支持进度追踪
- **应用前预览** — 在变更落地到主工作区前预览 worktree diff
- **审查门禁** — 可选的 stop-hook，在终端状态转换前提示审查

## 安装

### 前置条件

- 已安装并登录 Codex CLI
- `node` >= 20 且在 PATH 中
- Claude Code CLI `claude` 在 PATH 中（或设置 `CLAUDE_BIN` 环境变量）
- Git（写入模式需要 worktree 支持）

### 全局安装（推荐）

```bash
npm install -g @anyi61/codex-claude-delegate-mcp
```

验证安装：

```bash
codex-claude --version
```

### 配置

将 MCP 服务器配置写入 Codex 配置文件：

```bash
codex-claude setup --write
```

这会在 `~/.codex/config.toml` 中添加 `command = "codex-claude"` 及默认的 6 个工具。

选项：

| 参数 | 说明 |
|------|------|
| `--force` | 覆盖已有的 claude_delegate 配置（会创建带时间戳的备份） |
| `--allow-root <path>` | 将仓库添加到 `CODEX_CLAUDE_ALLOW_ROOTS` |
| `--project` | 写入 `./.codex/config.toml` 而不是全局配置 |
| `--print` | 预览将要写入的配置 |

### 诊断

验证安装是否正常：

```bash
codex-claude doctor
```

检查项：Node.js ≥ 20、包版本、Claude CLI 路径/版本、Git、worktree 支持、Codex 配置、默认工具、allow roots。

```bash
codex-claude doctor --json
```

### 打印配置

查看 MCP 服务器 TOML 配置（不写入文件）：

```bash
codex-claude print-config
codex-claude print-config --source /path/to/repo
codex-claude print-config --project
```

## 默认工具集

`setup --write` 和 `print-config` 启用恰好 6 个工具：

| 工具 | 用途 |
|------|------|
| `claude_setup` | 首次使用 / 检查工作区就绪状态 |
| `claude_task` | **推荐入口**，自动路由到读取/审查/写入 |
| `claude_job_wait` | 轮询后台任务直到终态 |
| `claude_result` | 获取最近完成的执行结果 + 下一步建议 |
| `claude_apply` | 预览或落地 worktree 变更到主工作区 |
| `claude_cleanup` | 清理过期的委托 worktree（默认 dry-run） |

## 使用流程

### 只读分析

```text
claude_task(mode="read", cwd="/path/to/repo", task="解释认证的工作原理")
  → claude_job_wait(cwd="...", job_id="job-xxx")
  → claude_result(cwd="...", prefer="latest-job")
```

### 审查 / 审计

```text
claude_task(mode="review", cwd="/path/to/repo", task="检查安全漏洞")
  → claude_job_wait → claude_result
```

### 写入 / 应用 / 清理

```text
claude_task(mode="write", cwd="/path/to/repo", task="实现特性 X")
  → claude_job_wait(cwd="...", job_id="...")
  → claude_result(cwd="...")
  → claude_apply(cwd="...", worktree_path=".claude/worktrees/...", preview=true)
  → user confirms → claude_apply(cwd="...", worktree_path="...", cleanup=true, confirmed_by_user=true)
  → claude_cleanup(cwd="...", dry_run=true)
```

## 高级 / 调试工具

这些工具**不**在默认配置中。需要手动在 `~/.codex/config.toml` 中启用：

```toml
[mcp_servers.claude_delegate]
enabled_tools = ["claude_status", "claude_runs", "claude_run_inspect", "claude_workspace_status", "claude_review_gate", "claude_query", "claude_review", "claude_implement", "claude_jobs", "claude_job_result", "claude_job_cancel", "claude_job_cleanup"]
```

| 工具 | 用途 |
|------|------|
| `claude_status` | 检查 Claude/Git/worktree/认证状态 |
| `claude_runs` | 列出历史运行日志 |
| `claude_run_inspect` | 按 run_id 查看单次运行详情 |
| `claude_workspace_status` | 聚合视图：任务 / 运行 / 会话 / worktrees |
| `claude_review_gate` | 启用/禁用/查看审查门禁状态 |
| `claude_query` | 只读问答（底层入口） |
| `claude_review` | 只读审查（底层入口） |
| `claude_implement` | 隔离 worktree 实现（底层入口） |
| `claude_jobs` | 列出后台任务 |
| `claude_job_result` | 按 job_id 读取任务结果 |
| `claude_job_cancel` | 取消正在运行的任务 |
| `claude_job_cleanup` | 清理过期的终端任务记录 |

## 重要说明

- **`claude_implement.files`** 是严格的范围控制，用于需要精确文件约束的场景。
- **未提交的工作区变更：** 默认返回 `needs_user`。传入 `dirty_policy=committed` 忽略本地变更，或 `dirty_policy=snapshot` 将脏文件复制到 worktree。
- **轮询行为：** `claude_job_wait` 不会长时间阻塞。当 `poll_too_soon=true` 时，等待到 `next_allowed_poll_at`。当 `waiting=true` 时，不要启动重复任务。
- **回合上限：** `claude_task` 不接受 `max_turns`。需要显式回合限制时，使用高级工具（`claude_query` / `claude_review` / `claude_implement`）。
- **应用安全：** `preview=true` 不会修改主工作区。非预览模式的 `claude_apply` 需要用户确认后设置 `confirmed_by_user=true`。
- **无效组合：** `preview=true` + `cleanup=true` 会被拒绝——预览不应删除 worktree。
- **下一步操作：** `claude_result` 和 `claude_job_wait` 仅建议预览操作（`preview=true`），绝不直接建议非预览应用。

## 配置

### 允许根目录（Allow roots）

默认允许的根目录为 `~/projects`、`~/work`、`~/codex-claude`。可通过以下方式扩展：

```toml
# ~/.codex/config.toml
[shell_environment_policy.set]
CODEX_CLAUDE_ALLOW_ROOTS = "/Users/you/projects:/Users/you/work:/Users/you/my-repo"
```

或使用 CLI：

```bash
codex-claude setup --write --allow-root "$(pwd)"
```

### 开发 / 维护

从源码构建：

```bash
git clone https://github.com/anyi61/codex-claude.git
cd codex-claude
npm install
npm run build:plugin
npm run check:plugin
```

插件目录（`plugins/`）用于内部打包。开发时使用 `npm run dev` 或 `npm run build`。

## 故障排查

| 问题 | 解决方法 |
|------|---------|
| `claude` 命令未找到 | 安装 Claude Code CLI 或设置 `CLAUDE_BIN` 环境变量 |
| cwd 不在 allow roots 中 | `codex-claude setup --write --allow-root "$(pwd)"` |
| 危险的 allow root | 使用具体的仓库路径，不要用 `/`、`/tmp`、`/etc` 或 `$HOME` |
| `poll_too_soon=true` | 等待到 `next_allowed_poll_at`，不要启动新任务 |
| `waiting=true` | 继续轮询同一个 `job_id`，不要重新委托 |
| 任务过期 | 使用 claude_result 检查；高级工具中可使用 claude_job_cancel |
| 应用被拒：工作区有未提交变更 | 提交或 stash 变更，或使用 `dirty_policy=committed` |
| 缺少 `confirmed_by_user` | 展示预览并获得用户明确批准后再应用 |
| `preview=true` + `cleanup=true` | 拆分为预览和已确认的应用+清理两步 |
| 残留 worktree | `claude_cleanup(cwd="...", dry_run=true)` 然后 `dry_run=false` |

## 卸载

```bash
npm uninstall -g @anyi61/codex-claude-delegate-mcp
```

要同时移除 Codex 中的 MCP 服务器配置，手动删除 `~/.codex/config.toml` 中的 `[mcp_servers.claude_delegate]` 部分。

## 安全

- `spawn("claude", args[])` — 无 shell 注入
- `--tools` / `--allowedTools` / `--disallowedTools` — 三层工具控制
- `--permission-mode dontAsk` — 非交互式安全模式
- `sanitizeEnv()` — 最小环境（剥离 API 密钥、令牌、SSH agent）
- `BRIDGE_DEPTH` — 递归保护（≥2 时拒绝）
- `validateCwd()` — realpath + allow roots 白名单
- `dangerousRoot()` — 拒绝 `/`、`/tmp`、`/etc`、`$HOME`

## 已知限制

- 不支持实时双向通信（Codex → Claude 单向委托）
- 每次调用 Claude 约 2-5 秒冷启动
- 无自动 worktree 清理（使用 `claude_cleanup`）
- 老旧的任务记录缺少指纹/心跳；过期分类回退到 updated_at
- 过期检测仅为参考，不会自动终止进程

## 维护者发布清单

```bash
# 确保 git 已提交所有更改
git status

# 一行发布: 自动 bump patch 版本 → build → test → publish
npm run release
```

发布后创建 GitHub Release 并推送 tag（如需）:

```bash
git tag v$(node -p "require('./package.json').version")
git push origin v$(node -p "require('./package.json').version")
```
