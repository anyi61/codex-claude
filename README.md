# codex-claude-delegate-mcp

让 Codex 通过插件把代码任务委托给 Claude Code 执行。插件内置自包含 MCP runtime，安装后无需在用户机器本地构建 `dist/`。

## 功能

- **委托读取/审查/写入任务** — 从 Codex 将读取、审查或写入任务发给 Claude Code
- **隔离 git worktree 执行** — 写入任务在独立 worktree 中运行，不影响主工作区
- **后台作业轮询** — 所有委托均排队为后台作业，支持进度查询和恢复
- **预览与落地变更** — 审查 worktree 差异后决定是否落地到主工作区
- **审查门** — 可选启用 stop-hook，在终态前提醒运行审查

## 快速开始

```text
# 1) 安装插件 → 退出并重新进入 Codex
# 2) 首次自检（若报不在允许根目录内，见下方配置说明）
claude_setup(cwd="/path/to/your/repo")

# 3) 发送第一次委托（推荐 read 模式）
claude_task(mode="read", cwd="/path/to/your/repo", task="Summarize this repo")
```

> 如果 `claude_setup` 报错工作区不在允许根目录内且仓库可信，重新运行：
> `claude_setup(cwd="/path/to/your/repo", configure_allow_root=true)`
> 这会自动将仓库添加到 CODEX_CLAUDE_ALLOW_ROOTS 并继续 setup。
> **注意：** 仅对受信任的仓库执行此操作，不宜添加宽泛或不受信任的目录。

首跑链路：`claude_setup` → `claude_task` → `claude_job_wait` → `claude_result`。

## 安装

### 前置条件

- Codex 需要支持插件。
- `PATH` 中需要有可执行的 `node`，插件 MCP server 会通过 `node` 启动。
- `PATH` 中需要有可执行的 Claude Code CLI `claude`，也可以通过 `CLAUDE_BIN` 指定路径。

### 作为 Codex 插件安装

1. 克隆本仓库并进入目录：

   ```bash
   git clone https://github.com/anyi/codex-claude.git
   cd codex-claude
   ```

2. 将当前仓库注册为 Codex 本地插件源：

   ```bash
   codex plugin marketplace add "$(pwd)"
   ```

3. 在 Codex 中输入 `/plugins`，找到 `codex-claude-delegate` 并安装或启用。
4. 退出并重新进入 Codex，让插件 MCP 工具完成加载。
5. 运行 `claude_setup(cwd="/path/to/your/repo")` 做首次自检。

插件已包含 `plugins/codex-claude-delegate/server/server.js` 和 `plugins/codex-claude-delegate/server/job-runner.js`，普通用户不需要运行 `npm install` 或 `npm run build`。如果 `claude_setup` 提示缺少 `server/server.js` 或 `job-runner.js`，在仓库根目录运行 `npm run build:plugin` 重新生成。

### 更新

```bash
git pull
```

然后重启 Codex，或刷新插件。如果你修改了 `src/` 下的源码，还需要运行：

```bash
npm install
npm run build:plugin
npm run check:plugin
```

### 卸载

1. 在 Codex 中输入 `/plugins`，卸载或禁用 `codex-claude-delegate`。
2. 确认本地 marketplace 中的插件名称：
   ```bash
   codex plugin marketplace list
   ```
   然后移除对应的 marketplace 条目（名称可能为 `codex-claude-local` 或基于仓库路径的自动名称）。
3. 退出并重新进入 Codex。
4. 如果曾使用手动 MCP 配置，移除对应 MCP server：
   ```bash
   codex mcp remove claude_delegate
   ```
5. 如果启动 Codex 仍提示 `invalid transport in mcp_servers.claude_delegate`，删除 `~/.codex/config.toml` 中残留的 `[mcp_servers.claude_delegate]` 或 `[mcp_servers.claude_delegate.env]` 配置块。
6. 可选清理本地文件：删除克隆下来的本仓库目录；在不再需要历史 job/run 状态的工作区中删除 `.codex-claude-delegate/`。

## 兼容性

- **Codex**：需要支持插件市场（≥ 2025 年底版本）。MCP 配置使用 `.mcp.json` 相对路径。
- **Claude Code CLI**：需要 `claude` 命令行可用，支持 `--permission-mode dontAsk`、`--allowedTools`、`--disallowedTools`、`--json-schema` 等标志。
- **Git**：写入模式需要 worktree 支持（`git worktree add --detach`）。
- **Node.js**：≥ 20（ESM 模块）。

## 使用流程

### 只读提问

```text
claude_task(mode="read", cwd="/path/to/your/repo", task="Explain how auth works")
  → 返回 job_id

claude_job_wait(cwd="/path/to/your/repo", job_id="job-xxx")
  → 轮询直到 waiting=false

claude_result(cwd="/path/to/your/repo", prefer="latest-job")
  → 返回标准化摘要和下一步建议
```

### 审查 / 审计

```text
claude_task(mode="review", cwd="/path/to/your/repo", task="Check for security issues")
  → claude_job_wait → claude_result
```

### 写入 / 落地 / 清理

```text
claude_task(mode="write", cwd="/path/to/your/repo", task="Implement feature X")
  → claude_job_wait(cwd="...", job_id="...")
  → claude_result(cwd="...")
  → claude_apply(cwd="...", worktree_path=".claude/worktrees/codex-delegated-xxx", preview=true)  # 预览
  → claude_apply(cwd="...", worktree_path=".claude/worktrees/codex-delegated-xxx", cleanup=true) # 落地+清理
  → claude_cleanup(cwd="...", dry_run=true)  # 确认无残留
```

## 工具

### 默认工具（日常使用）

| 工具 | 使用场景 |
|------|------|
| `claude_setup` | 首次使用 / 怀疑环境问题 |
| `claude_task` | **推荐入口**，自动按 mode 路由到 read/review/write |
| `claude_job_wait` | 轮询后台任务状态 → 拿到终态结果 |
| `claude_result` | 取当前最相关的已完成结果 + next_actions |
| `claude_apply` | 预览或落地 worktree 变更到主工作区 |
| `claude_cleanup` | 清理残留 worktree，默认 dry-run |

### 高级 / 调试工具

普通任务用 `claude_task`，不要直接调用底层工具。如确实需要，在 `~/.codex/config.toml` 的 `[mcp_servers.claude_delegate]` 中设置：

```toml
enabled_tools = ["claude_status", "claude_runs", "claude_run_inspect", "claude_workspace_status", "claude_review_gate", "claude_query", "claude_review", "claude_implement", "claude_jobs", "claude_job_result", "claude_job_cancel", "claude_job_cleanup"]
```

| 工具 | 使用场景 |
|------|------|
| `claude_status` | 检查 Claude/Git/worktree/认证状态 |
| `claude_runs` | 列出历史 run log |
| `claude_run_inspect` | 按 run_id 查看单次运行详情 |
| `claude_workspace_status` | 聚合视图：jobs / runs / sessions / worktrees |
| `claude_review_gate` | 启用/关闭 review gate |
| `claude_query` | 只读问答（底层入口） |
| `claude_review` | 只读审查（底层入口） |
| `claude_implement` | 隔离 worktree 实现（底层入口，支持 `files` 严格范围控制） |
| `claude_jobs` | 列出后台作业 |
| `claude_job_result` | 按 job_id 读取作业 |
| `claude_job_cancel` | 取消任务 |
| `claude_job_cleanup` | 清理旧终态作业记录 |

## 重要说明

- **`claude_task.files` 已废弃。** 传 `instruction_files` 替代。`claude_task` 的 `files` 只作上下文，不影响 apply 范围。
- **`claude_implement.files`** 是严格范围控制能力，用于需要精确限制修改范围的场景。
- **工作区有未提交改动时：** 默认返回 `needs_user`。传 `dirty_policy=committed` 忽略本地改动，或 `dirty_policy=snapshot` 将当前未提交文件复制进 worktree。
- **轮询行为：** `claude_job_wait` 不做长阻塞。返回 `poll_too_soon=true` 时等 `next_allowed_poll_at` 后重试。`waiting=true` 时不要本地重复执行或另起 job。

## 配置

### 允许的工作区根目录

默认只允许 `~/projects`、`~/work`、`~/codex-claude`。扩展：

```toml
# ~/.codex/config.toml
[shell_environment_policy.set]
CODEX_CLAUDE_ALLOW_ROOTS = "/Users/you/projects:/Users/you/work:/Users/you/my-repo"
```

### 手动安装 / 开发

如果你是维护者，从源码构建插件 runtime：

```bash
npm install
npm run build:plugin
npm run check:plugin
```

插件 MCP 入口固定为 `plugins/codex-claude-delegate/.mcp.json` 中相对插件根目录的 `./server/server.js`，后台 job runner 固定为同目录的 `./server/job-runner.js`。常规开发调试仍可使用 `npm run dev` 或 `npm run build`（根目录 `dist/`）。

## 故障排查

| 问题 | 处理方式 |
|---------|-----|
| 插件安装后工具不可用 | 重启 Codex/刷新插件，然后先运行 `claude_setup(cwd="...")` 查看环境检查结果 |
| 找不到 `server/server.js` 或 `server/job-runner.js` | 在仓库根目录执行 `npm run build:plugin`，再执行 `npm run check:plugin` |
| 旧版插件入口仍使用 `${CLAUDE_PLUGIN_ROOT}` | 拉取最新代码，重新安装插件，并确认 `plugins/codex-claude-delegate/.mcp.json` 使用 `./server/server.js` |
| 启动 Codex 报 `invalid transport in mcp_servers.claude_delegate` | 删除孤立的 `[mcp_servers.claude_delegate.env]` 配置块，改用 `[shell_environment_policy.set]` 设置 `CODEX_CLAUDE_ALLOW_ROOTS` |
| 找不到 `claude` 命令 | 安装 Claude Code CLI，或设置 `CLAUDE_BIN` |
| `cwd` 不在允许根目录内 | 运行 `claude_setup(cwd="...", configure_allow_root=true)`。或手动设置 `CODEX_CLAUDE_ALLOW_ROOTS` 并重启 Codex |
| `apply` 被拒绝 | 主工作区有未提交改动。先 commit/stash，或重试时传 `dirty_policy=committed` |
| 残留 worktree | `claude_cleanup(dry_run=true, cwd="...")` 确认后 `dry_run=false` |
| 任务卡住/超时 | `claude_job_cancel(cwd="...", job_id="...")` 后重新提交 |
| 作业活跃 | `claude_job_wait(cwd="...", job_id="...")` 轮询到终态 |
| `claude_setup` 报 `cwd` 无效 | 确保目录存在且是 git 仓库 |

## 安全边界与限制

- `spawn("claude", args[])` — 无 shell 注入
- `--tools` / `--allowedTools` / `--disallowedTools` — 工具三层控制
- `--permission-mode dontAsk` — 非交互安全模式
- `sanitizeEnv()` — **环境最小化**（剥离 API key、token、SSH agent 等敏感变量，保留进程基本环境）
- `BRIDGE_DEPTH` — 防递归委托（≥2 拒绝）
- `validateCwd()` — realpath + allow roots 白名单

> 注意：Claude 在 git worktree 中运行并受工具限制，但并非完整的操作系统沙箱。允许的命令包含 `npx`、`python`、`node` 等，用于运行测试和构建。系统不提供网络隔离或文件系统沙箱。

## 已知限制

- 无实时双向通信（Codex → Claude 一次性委托）
- 每次 Claude 调用冷启动 ~2-5s
- 不自动清理 worktree（需 `claude_cleanup`）
- 旧 job 记录无 fingerprint/heartbeat，stale 分类回退到 updated_at
- Stale 检测仅为建议，不自动杀进程
