# MCP 工具等待时间审查结果

日期：2026-05-06
范围：`/Users/anyi/codex-claude` 的 18 个 `claude_delegate` MCP 工具
触发问题：简单调用 `claude_query task: 当前项目有什么代码，都是什么作用` 时，真实用户等待约 40s。

## 结论摘要

主要等待不在 MCP stdio、参数校验、allow roots、JSON 包装层，而在会启动 Claude Code 的同步工具路径：

- `claude_query`
- `claude_review`
- `claude_implement`
- `claude_task` 的同步 `read/review/write` 分支

本地包装层通常是毫秒级；`claude_status` 约 0.8s；纯本地日志/状态类工具约 0-11ms。同步 `claude_query` 的实测等待为 8.6s 到 20.0s，小任务依然会启动完整 `claude -p` 子进程、加载仓库上下文、执行模型推理，并等待 Claude 完整返回结构化 JSON。用户感受到 40s 时，最可能是以下节点叠加：

- Claude CLI 冷启动、模型队列或标准服务层推理延迟。
- 查询任务允许 `Read/Glob/Grep/Bash`，Claude 可能主动读取仓库，简单问题也变成一次仓库扫描。
- 默认 `max_turns=8`、`timeout_sec=120` 对简单查询偏大。
- `runClaudeQuery` 默认自动恢复最近 query session；如果上下文很大、会话陈旧或恢复失败再重试，会放大等待。
- 同步工具没有阶段化进度事件；用户只能看到一个长时间等待，无法知道卡在启动、读仓库、模型推理还是结果解析。

## 实测证据

环境：`/Users/anyi/codex-claude`，通过 Node 直接调用 `dist/server.js` 的 `handleToolCall`，并补充直接 Claude CLI 基线。

| 测试项 | 实测耗时 | 说明 |
| --- | ---: | --- |
| `claude --version` | 0.57s | Claude CLI 可用性检查基线 |
| `claude auth status` | 0.70s | auth 检查基线 |
| `git status --short` | 0.05s | git 本地检查基线 |
| 直接 `claude -p`，`max-turns=1`，不显式给工具 | 8.85s | Claude CLI + 模型调用本身就不是毫秒级 |
| `claude_query`，首轮，`max_turns=4` | 20.0s | MCP import 0.13s，工具调用 19.9s；Claude stdout 内部 `duration_ms=15461` |
| `claude_query`，复用 query session，`max_turns=2` | 8.93s | stdout 内部 `duration_ms=4202`，但 CLI 总耗时仍接近 9s |
| `claude_runs` | 11ms | 纯本地 run log 读取 |
| `claude_workspace_status include_terminal=true` | 3ms | 当前样本中 job/run/worktree 数量少 |
| `claude_workspace_status include_terminal=false` | 1ms | 纯本地聚合 |
| `claude_jobs` | <1ms | 纯本地 job 读取 |
| `claude_cleanup dry_run=true` | 1ms | 当前样本中 worktree 数量少 |
| `claude_review_gate status` | 1ms | 纯本地配置读取 |
| `claude_status` | 809ms | 主要来自 `claude --version` + `claude auth status` |

## 链路分解

### 入口层

文件：`src/server.ts`

所有工具先走 `handleToolCall`，执行 schema 校验和 `validateCwd`。这部分是本地操作，通常毫秒级。

高等待从以下分支开始：

- `claude_query` 在 `src/server.ts:481` 到 `src/server.ts:499` 同步调用 `runClaudeQuery`。
- `claude_review` 在 `src/server.ts:502` 到 `src/server.ts:522` 同步调用 `runClaudeReview`。
- `claude_implement` 在 `src/server.ts:525` 到 `src/server.ts:564` 同步准备 worktree 并调用 `runClaudeImplement`。
- `claude_task` 在 `src/server.ts:453` 到 `src/server.ts:470` 再按模式路由到 query/review/implement。

### Claude 子进程层

文件：`src/claude-cli.ts`

核心等待点是 `spawnClaude`：

- `src/claude-cli.ts:1793` 构造完整 Claude CLI 参数。
- `src/claude-cli.ts:1801` 启动 `spawn(CLAUDE_BIN, args)`。
- `src/claude-cli.ts:1804` 使用 `timeoutSec * 1000`，默认 query 为 120s、review 为 180s、implement 为 600s。
- `src/claude-cli.ts:1828` 只有子进程 close 后才解析 stdout 并返回。

这意味着同步工具没有中间响应。Claude 需要读仓库、调用模型、生成结构化 JSON，MCP 才能把结果一次性返回。

### query 特有节点

文件：`src/claude-cli.ts`

- `src/claude-cli.ts:2356` 初始化 session store。
- `src/claude-cli.ts:2357` 计算 repo key。
- `src/claude-cli.ts:2360` 在 20 分钟窗口内自动找最近 query session。
- `src/claude-cli.ts:2365` 把 `resumeSessionId` 传给 Claude。
- `src/claude-cli.ts:2389` 到 `src/claude-cli.ts:2408` 遇到 session not found/expired 时会再跑一次无 resume 的 Claude 调用。

风险：自动恢复能提升连续对话质量，但对简单 query 有两个副作用。第一，会把旧上下文带入，可能增加输入 token 和思考路径。第二，session 失效时可能先失败再重试，等待时间接近翻倍。

### status/setup 节点

文件：`src/claude-cli.ts`

- `claude_status` 调用 `checkClaudeStatus`。
- `src/claude-cli.ts:2268` 执行 `claude --version`。
- `src/claude-cli.ts:2278` 执行 `claude auth status`。
- `src/claude-cli.ts:2293` 执行 `git --version`。
- `src/claude-cli.ts:2302` 执行 `git worktree list`。
- `src/claude-cli.ts:2311` 还用 `execSync("git rev-parse --git-dir")` 做同步检查。
- `claude_setup` 在 `src/claude-cli.ts:1058` 复用 `checkClaudeStatus`，因此耗时与 status 相近。

风险：不是 40s 主因，但每次 setup/status 都重复启动 Claude CLI 两次。可以接受，但可缓存。

## 18 个工具逐项审查

| 工具 | 当前耗时特征 | 风险等级 | 延迟节点 | 建议 |
| --- | --- | --- | --- | --- |
| `claude_status` | 约 0.8s | 低 | `claude --version`、`claude auth status`、git 检查串行执行 | 加 5-10s TTL 缓存；把 git/Claude 检查并行化 |
| `claude_setup` | 约等于 status | 低 | 复用 `checkClaudeStatus` | 复用 status 缓存；`configure_allow_root` 后返回明确“无需重启/需要重启” |
| `claude_runs` | 毫秒级 | 低 | 扫描 run log JSON | run log 多时增加索引或按 mtime 截断扫描 |
| `claude_run_inspect` | 毫秒级 | 低 | 单个 run log JSON | 保持现状 |
| `claude_result` | 毫秒级到几十毫秒 | 中 | 默认会列 3 类 terminal jobs，再列 runs | job/run 多时可能变慢；加 workspace 索引或 latest 指针 |
| `claude_workspace_status` | 当前毫秒级 | 中 | 并行读 jobs/runs/worktrees/sessions | 大仓库/大量 job 文件时可能膨胀；默认 `include_terminal=false` 或限制 terminal job 扫描 |
| `claude_task` | 取决于分派 | 高 | 同步 read/review/write 会进入 Claude 子进程 | 对 auto/read 的简单问题默认建议 `background=true` 或 `fast_query` 模式 |
| `claude_review_gate` | 毫秒级 | 低 | 本地 JSON 和 hook 文件 | 保持现状 |
| `claude_query` | 高，8-40s 可出现 | 高 | Claude CLI 子进程、仓库读取、模型推理、自动 session resume | 增加轻量 query 模式；默认更低 `max_turns`；可选禁用 auto-resume；返回阶段化 timing |
| `claude_review` | 高，通常比 query 更慢 | 高 | Claude CLI 子进程、diff/read、模型审查 | broad review 默认建议 background；对 `files/diff` 缺失给出同步慢提示 |
| `claude_implement` | 最高，可能数分钟 | 高 | git worktree add、Claude 编码、observeResult 多次 git diff/status | 同步保留但强提示 background；输出阶段 timing；worktree 和 observe 阶段分别计时 |
| `claude_jobs` | 毫秒级 | 低 | jobs JSON 扫描 | job 多时加索引 |
| `claude_job_result` | 毫秒级 | 低 | 单 job JSON | 保持现状 |
| `claude_job_cancel` | 毫秒级 | 中 | SIGTERM job runner；真实 Claude 子进程终止依赖 runner handler | 增加取消后的状态验证和 grace-period SIGKILL 策略 |
| `claude_job_wait` | 可人为等待 30s | 中 | 轮询直到终态，默认 `timeout_ms=30000` | 返回“等待中”而不是抛错；建议默认短轮询或由 Codex 控制 wait |
| `claude_job_cleanup` | 毫秒级 | 低 | jobs JSON 扫描/删除 | job 多时加索引 |
| `claude_apply` | 小到中等 | 中 | 找 implement log、git diff/status、逐文件复制、可选 worktree remove | 避免每次全量扫描 logs；使用 run_id/worktree 映射 |
| `claude_cleanup` | 小到中等 | 中 | 扫描 `.claude/worktrees`，可选 git worktree remove/prune | worktree 多时慢；dry-run 保持快，真实清理建议 background |

## 根因判断

根因不是单个“卡死 bug”，而是当前工具设计把真实 Claude Code 子进程作为同步 MCP 调用返回。对简单说明类问题，这个路径仍然执行完整代理流程：

1. Codex 发起 MCP tool call。
2. MCP server 校验 cwd 和 schema。
3. `runClaudeQuery` 查 session，可能自动 resume。
4. `spawnClaude` 启动 `claude -p`。
5. Claude CLI 加载上下文、执行工具、调用模型。
6. Claude 输出 JSON 后，MCP 才一次性返回。

在这个模型下，20s 是合理可复现的；40s 是可解释的尾延迟。用户体验问题在于缺少“简单问题的低延迟路径”和“同步等待期间的阶段可见性”。

## 解决办法

### P0：增加阶段化耗时观测

给所有工具返回统一 timing 字段，至少包含：

- `validate_cwd_ms`
- `session_lookup_ms`
- `spawn_claude_ms`
- `claude_reported_duration_ms`
- `claude_reported_api_duration_ms`
- `postprocess_ms`
- `log_write_ms`
- `total_ms`

对 `claude_implement` 额外包含：

- `dirty_check_ms`
- `worktree_prepare_ms`
- `claude_run_ms`
- `observe_result_ms`
- `review_gate_mark_ms`

验收标准：

- 调用 `claude_query` 后结果能明确显示主要耗时是否在 `spawn_claude_ms`。
- 调用 `claude_status/setup/runs/workspace_status/apply/cleanup` 后也有本地阶段耗时。
- 审查时不再需要靠外部 `/usr/bin/time` 猜链路。

### P1：提供低延迟 query 模式

新增 query 入参，建议命名：

- `fast?: boolean`
- `resume?: boolean`
- `max_files?: number`
- `detail?: "brief" | "normal" | "deep"`

建议行为：

- `fast=true` 时默认 `max_turns=1 或 2`。
- `fast=true` 时默认不自动 resume，除非显式 `resume=true`。
- `fast=true` 时 prompt 明确要求优先读取 `README.md/package.json/src` 列表，不做广泛仓库扫描。
- 对“当前项目有什么代码”这类常见问题可走固定摘要策略，减少 Claude 自由探索。

验收标准：

- 在本项目上 `claude_query fast=true task=当前项目有什么代码，都是什么作用` P50 小于 10s。
- 返回结果仍包含核心模块，不要求全面审计级完整性。
- fast 模式和普通模式在返回中明确标记。

### P1：同步调用给出明确使用建议

对可能长时间运行的同步工具，在返回或错误中增加 `next_actions`：

- query/review 超过建议阈值时提示下次可用 `background=true`。
- review/implement 如果没有 `background=true` 且 timeout 大于 60s，返回中标注“这是同步阻塞路径”。
- `claude_task auto` 推断为 write/review 时，若用户没有显式要求同步，建议 background。

验收标准：

- README 和工具描述都说明同步/后台差异。
- 用户能通过 `claude_query background=true` 立即拿到 job id，然后用 `claude_job_wait/result` 轮询。

### P2：缓存和并行化 status/setup

优化 `checkClaudeStatus`：

- `claude --version`、`claude auth status`、`git --version`、`git worktree list` 并行执行。
- 对 Claude version/auth 做短 TTL 缓存。
- 避免混用 async `execCapture` 和 sync `execSync`。

验收标准：

- `claude_status` 在本项目热路径小于 500ms。
- `claude_setup` 不比 `claude_status` 慢超过 100ms。

### P2：减少本地扫描的尾延迟

优化日志和 worktree 查找：

- `findImplementLogForWorktree` 当前会扫描 `LOG_DIR` 下所有 JSON；为 worktree 写入索引或在 apply 入参支持 `run_id`。
- `JobStore.list` 当前每次读取所有 job JSON；job 多时应增加按状态/mtime 索引。
- `workspace_status` 默认可不加载 terminal jobs，或者把 terminal job 扫描限制为最近 N 个文件。

验收标准：

- 构造 1000 个 run log/job 文件时，`claude_workspace_status limit=10` 小于 300ms。
- `claude_apply preview=true` 不因大量历史 run log 明显变慢。

## 建议验收清单

- [ ] 所有 18 个工具返回统一 `execution/timing` 信息，或在本地工具中有等价 timing。
- [ ] `claude_query` 可用 `fast=true`，简单项目说明任务 P50 小于 10s。
- [ ] `claude_query` 可显式 `resume=false`，并能证明不会传 `-r`。
- [ ] `claude_task` 分派到同步长任务时，结果或文档明确提示 background 使用方式。
- [ ] `claude_status` 热路径小于 500ms。
- [ ] `claude_workspace_status` 在 1000 个 job/run 文件样本下小于 300ms。
- [ ] `claude_apply` 可通过 `run_id` 或索引定位 implement log，不依赖全量扫描。
- [ ] README 增加“为什么简单 query 也可能等 20-40s”的说明。
- [ ] README 增加“低延迟 query”和“后台任务轮询”的推荐用法。
- [ ] 回归测试覆盖：query fast 参数、resume=false、timing 字段、status 缓存、workspace 大量日志性能。

## 本次未直接修改代码的原因

本次任务是排查链路并给出审查结果文件。根据实测，问题不是一个单行 bug，而是同步工具架构和缺少低延迟模式导致的体验问题。建议先按上面的 P0/P1/P2 分阶段实施，避免在没有验收基准的情况下把 query、session、background job 三条链路混在一起改。
