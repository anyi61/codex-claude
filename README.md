# codex-claude-delegate-mcp

让 Codex 通过插件把代码任务委托给 Claude Code 执行。插件内置自包含 MCP runtime，安装后无需在用户机器本地构建 `dist/`。

## Features



## Quick start

```bash
# 1) 按下方 Install 安装插件，然后重启 Codex（或刷新插件）
# 2) 首次自检
claude_setup(cwd="/path/to/your/repo")

# 3) 发送第一次委托（推荐 read 模式）
claude_task(mode="read", cwd="/path/to/your/repo", task="Summarize this repo")
# 返回 job_id 后继续用 claude_job_wait 轮询到终态
```

首跑链路建议固定为：`claude_setup` -> `claude_task` -> `claude_job_wait` -> `claude_result`。完整 18 个工具列表见下方。

## Install

### Prerequisites

- Codex with plugin support.
- Node.js available as `node` on `PATH` because the plugin MCP server is launched with `node`.
- Claude Code CLI available as `claude` on `PATH`, or configure `CLAUDE_BIN`.

### Install as a Codex plugin

1. Clone or download this repository.
2. In Codex, install the local plugin directory: `plugins/codex-claude-delegate`.
3. Restart Codex or refresh plugins.
4. Run `claude_setup(cwd="/path/to/your/repo")`.

The plugin includes `plugins/codex-claude-delegate/server/server.js`, so normal users do not need `npm install` or `npm run build`. If `claude_setup` reports `server/server.js` missing, rebuild from the repository root with `npm run build:plugin`.

### Update

```bash
git pull
```

Then restart Codex or refresh plugins. If you modified files under `src/`, also run:

```bash
npm install
npm run build:plugin
npm run check:plugin
```

### Uninstall

1. Remove `codex-claude-delegate` from Codex plugins, or delete/unlink the installed plugin directory.
2. Restart Codex or refresh plugins.
3. If you used the manual MCP config path, remove the `[mcp_servers.claude_delegate]` block from `~/.codex/config.toml`.
4. Optional per-workspace cleanup: remove `.codex-claude-delegate/` from repositories where you no longer want stored job/run state.

## Minimal example

```text
Codex: claude_task(mode="read", task="Explain how auth works in this repo.")
  → Server returns: { job_id: "job-xxx", delegated_mode: "read", next_actions: [...] }

Codex: claude_job_wait(job_id="job-xxx")
  → Server returns: { waiting: true, recommended_delay_ms: 10000, ... }
  → (poll until waiting: false)

Codex: claude_job_wait(job_id="job-xxx")
  → Server returns: { waiting: false, status: "succeeded", result: { answer: "..." } }

Codex: claude_result(prefer="latest-job")
  → Normalized summary + next steps
```

典型写流程：

```text
claude_task(mode="write") → claude_job_wait → claude_result
  → claude_apply(preview=true) → claude_apply(cleanup=true) → claude_cleanup
```

## Tools

### Default (日常使用)

| Tool | When |
|------|------|
| `claude_setup` | 首次使用 / 怀疑环境问题 |
| `claude_task` | **推荐入口**，自动按 mode 路由到 read/review/write |
| `claude_job_wait` | 轮询后台任务状态 → 拿到终态结果 |
| `claude_result` | 取当前最相关的已完成结果 + next_actions |
| `claude_apply` | 预览或落地 worktree 变更到主工作区 |
| `claude_cleanup` | 清理残留 worktree，默认 dry-run |

### Advanced / Debug (默认禁用，按需启用)

| Tool | When |
|------|------|
| `claude_status` | 检查 Claude/Git/worktree/认证状态 |
| `claude_runs` | 列出历史 run log |
| `claude_run_inspect` | 按 run_id 查看单次运行详情 |
| `claude_workspace_status` | 聚合视图：jobs / runs / sessions / worktrees |
| `claude_review_gate` | 启用/关闭 review gate |
| `claude_query` | 只读问答（底层入口） |
| `claude_review` | 只读审查（底层入口） |
| `claude_implement` | 隔离 worktree 实现（底层入口，支持 `files` strict scope） |
| `claude_jobs` | 列出后台作业 |
| `claude_job_result` | 按 job_id 读取作业 |
| `claude_job_cancel` | 取消任务 |
| `claude_job_cleanup` | 清理旧终态作业记录 |

> 普通任务用 `claude_task`，不要直接调用 `claude_query`/`claude_review`/`claude_implement`。普通轮询用 `claude_job_wait`/`claude_result`。

## Important notes

- **claude_task.files is deprecated.** 传 `instruction_files` 替代。`claude_task` 的 `files` 只作上下文，不影响 apply 范围。
- **claude_implement.files** 是 strict scope 能力，用于需要精确限制修改范围的场景。
- **Dirty workspace 处理：** 默认返回 `needs_user`。传 `dirty_policy=committed` 忽略本地改动，或 `dirty_policy=snapshot` 将当前未提交文件复制进 worktree。
- **轮询行为：** `claude_job_wait` 不做长阻塞。返回 `poll_too_soon=true` 时等 `next_allowed_poll_at` 后重试。`waiting=true` 时不要本地重复执行或另起 job。

## Configuration

### Allow roots

默认只允许 `~/projects`、`~/work`、`~/codex-claude`。扩展：

```toml
# ~/.codex/config.toml
[mcp_servers.claude_delegate.env]
CODEX_CLAUDE_ALLOW_ROOTS = "/Users/you/projects:/Users/you/work:/Users/you/my-repo"
```

### 启用高级工具

在 `enabled_tools` 中添加需要的工具名即可。

### Manual install / development

如果你是维护者，从源码构建插件 runtime：

```bash
npm install
npm run build:plugin
npm run check:plugin
```

插件 MCP 入口固定为 `plugins/codex-claude-delegate/.mcp.json` 中的 `${CLAUDE_PLUGIN_ROOT}/server/server.js`。常规开发调试仍可使用 `npm run dev` 或 `npm run build`（根目录 `dist/`）。

## Troubleshooting

| Problem | Fix |
|---------|-----|
| 插件安装后工具不可用 | 重启 Codex/刷新插件，然后先运行 `claude_setup` 查看环境检查结果 |
| `server/server.js` not found | 在仓库根目录执行 `npm run build:plugin`，再执行 `npm run check:plugin` |
| `${CLAUDE_PLUGIN_ROOT}` 未解析 | 重新安装插件并确认通过插件入口加载；当前配置依赖该变量 |
| `claude command not found` | 安装 Claude Code CLI，或设置 `CLAUDE_BIN` |
| `cwd outside allowRoots` | 设置 `CODEX_CLAUDE_ALLOW_ROOTS` 并重启 Codex |
| `apply refused` | 主工作区有未提交改动。先 commit/stash，或重试时传 `dirty_policy=committed` |
| 残留 worktree | `claude_cleanup(dry_run=true)` 确认后 `dry_run=false` |
| 任务卡住/超时 | `claude_job_cancel(job_id=...)` 后重新提交 |

## Security

- `spawn("claude", args[])` — 无 shell 注入
- `--tools` / `--allowedTools` / `--disallowedTools` — 工具三层控制
- `--permission-mode dontAsk` — 非交互安全模式
- `sanitizeEnv()` — 剥离 API key、token、SSH agent
- `BRIDGE_DEPTH` — 防递归委托（≥2 拒绝）
- `validateCwd()` — realpath + allow roots 白名单

## Known limitations

- 无实时双向通信（Codex → Claude 一次性委托）
- 每次 Claude 调用冷启动 ~2-5s
- 不自动清理 worktree（需 `claude_cleanup`）
- 旧 job 记录无 fingerprint/heartbeat，stale 分类回退到 updated_at
- Stale 检测仅为建议，不自动杀进程
