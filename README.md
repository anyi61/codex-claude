# codex-claude-delegate-mcp

让 Codex 通过插件把代码任务委托给 Claude Code 执行。插件内置自包含 MCP runtime，安装后无需在用户机器本地构建 `dist/`。

## 功能



## 快速开始

```bash
# 1) 按下方“安装”章节安装插件，然后重启 Codex（或刷新插件）
# 2) 首次自检
claude_setup(cwd="/path/to/your/repo")

# 3) 发送第一次委托（推荐 read 模式）
claude_task(mode="read", cwd="/path/to/your/repo", task="Summarize this repo")
# 返回 job_id 后继续用 claude_job_wait 轮询到终态
```

首跑链路建议固定为：`claude_setup` -> `claude_task` -> `claude_job_wait` -> `claude_result`。完整 18 个工具列表见下方。

## 安装

### 前置条件

- Codex 需要支持插件。
- `PATH` 中需要有可执行的 `node`，插件 MCP server 会通过 `node` 启动。
- `PATH` 中需要有可执行的 Claude Code CLI `claude`，也可以通过 `CLAUDE_BIN` 指定路径。

### 作为 Codex 插件安装

1. 克隆或下载本仓库。
2. 在 Codex 中安装本地插件目录：`plugins/codex-claude-delegate`。
3. 重启 Codex，或刷新插件。
4. 运行 `claude_setup(cwd="/path/to/your/repo")` 做首次自检。

插件已包含 `plugins/codex-claude-delegate/server/server.js`，普通用户不需要运行 `npm install` 或 `npm run build`。如果 `claude_setup` 提示缺少 `server/server.js`，在仓库根目录运行 `npm run build:plugin` 重新生成。

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

1. 从 Codex 插件中移除 `codex-claude-delegate`，或删除/取消链接已安装的插件目录。
2. 重启 Codex，或刷新插件。
3. 如果曾使用手动 MCP 配置，删除 `~/.codex/config.toml` 中的 `[mcp_servers.claude_delegate]` 配置块。
4. 可选清理工作区状态：在不再需要历史 job/run 状态的仓库中删除 `.codex-claude-delegate/`。

## 最小示例

```text
Codex: claude_task(mode="read", task="Explain how auth works in this repo.")
  → 服务端返回：{ job_id: "job-xxx", delegated_mode: "read", next_actions: [...] }

Codex: claude_job_wait(job_id="job-xxx")
  → 服务端返回：{ waiting: true, recommended_delay_ms: 10000, ... }
  → 继续轮询，直到 waiting 为 false

Codex: claude_job_wait(job_id="job-xxx")
  → 服务端返回：{ waiting: false, status: "succeeded", result: { answer: "..." } }

Codex: claude_result(prefer="latest-job")
  → 返回标准化摘要和下一步建议
```

典型写流程：

```text
claude_task(mode="write") → claude_job_wait → claude_result
  → claude_apply(preview=true) → claude_apply(cleanup=true) → claude_cleanup
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

### 高级 / 调试工具（默认禁用，按需启用）

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

> 普通任务用 `claude_task`，不要直接调用 `claude_query`/`claude_review`/`claude_implement`。普通轮询用 `claude_job_wait`/`claude_result`。

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
[mcp_servers.claude_delegate.env]
CODEX_CLAUDE_ALLOW_ROOTS = "/Users/you/projects:/Users/you/work:/Users/you/my-repo"
```

### 启用高级工具

在 `enabled_tools` 中添加需要的工具名即可。

### 手动安装 / 开发

如果你是维护者，从源码构建插件 runtime：

```bash
npm install
npm run build:plugin
npm run check:plugin
```

插件 MCP 入口固定为 `plugins/codex-claude-delegate/.mcp.json` 中的 `${CLAUDE_PLUGIN_ROOT}/server/server.js`。常规开发调试仍可使用 `npm run dev` 或 `npm run build`（根目录 `dist/`）。

## 故障排查

| 问题 | 处理方式 |
|---------|-----|
| 插件安装后工具不可用 | 重启 Codex/刷新插件，然后先运行 `claude_setup` 查看环境检查结果 |
| 找不到 `server/server.js` | 在仓库根目录执行 `npm run build:plugin`，再执行 `npm run check:plugin` |
| `${CLAUDE_PLUGIN_ROOT}` 未解析 | 重新安装插件并确认通过插件入口加载；当前配置依赖该变量 |
| 找不到 `claude` 命令 | 安装 Claude Code CLI，或设置 `CLAUDE_BIN` |
| `cwd` 不在允许根目录内 | 设置 `CODEX_CLAUDE_ALLOW_ROOTS` 并重启 Codex |
| `apply` 被拒绝 | 主工作区有未提交改动。先 commit/stash，或重试时传 `dirty_policy=committed` |
| 残留 worktree | `claude_cleanup(dry_run=true)` 确认后 `dry_run=false` |
| 任务卡住/超时 | `claude_job_cancel(job_id=...)` 后重新提交 |

## 安全

- `spawn("claude", args[])` — 无 shell 注入
- `--tools` / `--allowedTools` / `--disallowedTools` — 工具三层控制
- `--permission-mode dontAsk` — 非交互安全模式
- `sanitizeEnv()` — 剥离 API key、token、SSH agent
- `BRIDGE_DEPTH` — 防递归委托（≥2 拒绝）
- `validateCwd()` — realpath + allow roots 白名单

## 已知限制

- 无实时双向通信（Codex → Claude 一次性委托）
- 每次 Claude 调用冷启动 ~2-5s
- 不自动清理 worktree（需 `claude_cleanup`）
- 旧 job 记录无 fingerprint/heartbeat，stale 分类回退到 updated_at
- Stale 检测仅为建议，不自动杀进程
