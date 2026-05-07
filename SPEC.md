# Spec: Codex → Claude Code Task Delegation

## 1. 目标

让 **Codex CLI 规划任务后，把执行工作委托给 Claude Code**，Codex 验收结果。

不做：两个 agent 实时双向聊天、Claude 主动向 Codex 发消息。

## 2. 架构

```
Codex CLI
  └─ MCP Client (Codex 原生支持)
       └─ stdio ── codex-claude-delegate-mcp (Node.js MCP Server)
            └─ spawn("claude", argsArray) → claude -p
                 └─ --worktree, --json-schema, 结构化返回
```

### 模块分工

```
src/
├── server.ts       # MCP stdio 入口，18 个工具注册与分发
├── claude-cli.ts   # Claude CLI 启动、后台作业管理、结果观测、apply 范围检查
├── jobs.ts         # JobStore 类：基于文件系统的作业持久化、fingerprint 去重、心跳
├── job-runner.ts   # Detached worker 进程入口
├── session.ts      # SessionStore 类：会话持久化与复用
├── guard.ts        # 安全：cwd 校验、env 清理、递归防护
├── schema.ts       # 类型定义、Zod 校验、JSON Schema、prompt 构建器
└── codex-config.ts # Codex allow_roots 配置读写
```

## 3. MCP Tools（18 个）

### 3.1 按使用层次分类

| 层次 | 工具 | 功能 |
|------|------|------|
| **Default** | `claude_setup` | 完整就绪检查 + configure_allow_root |
| | `claude_task` | 高层入口，按 mode=auto/read/review/write 路由到 query/review/implement |
| | `claude_job_wait` | 单次查看后台任务状态（含轮询节流、过期检测、动态延迟） |
| | `claude_result` | 取当前工作区最相关的已完成 job/run 摘要 |
| | `claude_apply` | 预览或合并 delegated worktree 变更到主工作区 |
| | `claude_cleanup` | 清理 `.claude/worktrees/codex-delegated-*` worktree |
| **Advanced/Debug** | `claude_status` | 检查 Claude CLI/Git/worktree/允许根目录 |
| | `claude_runs` | 列出历史 run log |
| | `claude_run_inspect` | 按 run id 深入查看原始记录 |
| | `claude_workspace_status` | 聚合视图：jobs/runs/sessions/worktrees/attention |
| | `claude_review_gate` | 查询、启用、关闭 repo-local review gate |
| | `claude_query` | 只读问答（底层入口） |
| | `claude_review` | 只读审查（底层入口） |
| | `claude_implement` | 隔离 worktree 实现（底层入口） |
| | `claude_jobs` | 列出后台作业 |
| | `claude_job_result` | 按 job_id 读取作业状态 |
| | `claude_job_cancel` | 取消 queued/running 作业 |
| | `claude_job_cleanup` | 清理旧终态作业记录 |

### 3.2 默认工作流

```
claude_setup → claude_task → claude_job_wait → claude_result
  → claude_apply(preview=true) → claude_apply(cleanup=true) → claude_cleanup
```

### 3.3 claude_task.files 策略

`claude_task.files` 已废弃，合并为 `instruction_files`（仅上下文，不限制 apply scope）。需严格文件修改限制时，使用 Advanced `claude_implement` 并传入 `files`。

### 3.4 结构化返回

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
  changed_files: string[];
  diff_stat: string;
  diff_name_only: string;
  base_commit?: string;
  worktree_path?: string;
  resource_limits?: {
    max_cost_usd?: number;
    max_changed_files?: number;
    actual_changed_files: number;
    changed_files_exceeded: boolean;
    warnings: string[];
  };
  scope?: {
    requested_files?: string[];
    out_of_scope_files: string[];
    scope_exceeded: boolean;
    warnings: string[];
  };
}
```

## 4. 后台作业模型

### 4.1 生命周期

```
queued → running → succeeded | failed | cancelled
```

所有执行型入口默认入队并快速返回 job_id。调用方通过 `claude_job_wait` 轮询。

### 4.2 去重

通过 sha256 fingerprint（cwd + type + mode + task + files + dirty_policy + session controls + max_changed_files + max_cost_usd）检测活跃重复任务。命中时返回 `deduped=true` + `do_not_start_duplicate_job=true`。

### 4.3 心跳

Running job 每 15s 刷新 `heartbeat_at`，不依赖 Claude stdout。用于过期检测。

### 4.4 过期分类

| 状态 | 条件 | 建议操作 |
|------|------|---------|
| fresh | heartbeat_age ≤ 90s | claude_job_wait 继续轮询 |
| stale_candidate | 90s < heartbeat_age ≤ 300s | 再等一次（delay=30s） |
| stale | heartbeat_age > 300s 或 pid 不存活 | cancel / status / result |

### 4.5 轮询节流

记录 `last_wait_at` + `last_wait_recommended_delay_ms`。调用间隔小于上次推荐延迟时：
- 返回 `poll_too_soon=true` + `remaining_delay_ms` + `next_allowed_poll_at`
- 包含 `not_before` 参数在 next_actions 中
- 不刷新 `last_wait_at`

### 4.6 动态轮询延迟

| 作业年龄 | 推荐间隔 |
|----------|----------|
| < 30s | 10s |
| 30s ~ 2min | 20s |
| 2min ~ 10min | 45s |
| 10min ~ 30min | 60s |
| > 30min | 90s |
| stale_candidate | 30s |

## 5. 安全设计

### 5.1 多层防护

| 层 | 机制 |
|----|------|
| 递归防护 | BRIDGE_DEPTH ≤ 2，每次 spawn 加 1 |
| cwd 校验 | realpath + allowRoots 白名单 |
| 环境清理 | 移除 SECRET/TOKEN/CREDENTIAL/PASSWORD/API_KEY |
| 命令注入 | spawn("claude", args[]) 非 shell 字符串 |
| 工具白名单 | --tools + --allowedTools + --disallowedTools |
| 非交互模式 | --permission-mode dontAsk |
| stdout 保护 | 日志写 stderr 或文件 |
| server_observed | 服务端 git diff 独立验证 |

### 5.2 环境变量清理

只透传 `PATH, HOME, SHELL, LANG, LC_ALL, TERM, USER, TMPDIR, TEMP, TMP, NODE_ENV`。
隐式移除所有含 `SECRET, TOKEN, CREDENTIAL, PASSWORD, API_KEY` 的变量。
显式移除：`OPENAI_API_KEY, ANTHROPIC_API_KEY, GITHUB_TOKEN, GH_TOKEN, AWS_*, CLOUDFLARE_API_TOKEN, DOCKER_PASSWORD, NPM_TOKEN, SSH_AUTH_SOCK, SSH_AGENT_PID`。

## 6. 会话策略

| Type | 复用策略 | CLI flags |
|------|---------|-----------|
| query | 自动 resume 最近 20 分钟内同 repo 的 query session | `-p -r <session_id>` |
| review | 不复用，不写入 session store | `--no-session-persistence` |
| implement | 仅当用户显式传 session_key/fork_session/resume_latest | `-p -r <session_id> [--fork-session]` |

## 7. Known CLI 坑

1. `--json-schema` 必须是 prompt 前最后一个参数，必须在 `--allowedTools/--disallowedTools` 之后
2. 默认不设 `--max-turns`，仅用户显式传入时添加
3. `claude auth status` 返回 JSON，需 `JSON.parse`
4. 三个 JSON Schema 不可共用（QUERY / REVIEW / IMPLEMENT 各自独立）
5. job.status 与 result_status 分离：进程 succeeded 但任务可能是 partial

## 8. 已知限制

1. 无实时双向通信 — Codex 不能中途补充指令
2. 每次 Claude 调用是冷启动（新进程 ~2-5s）
3. 不自动清理所有 worktree — 需 claude_cleanup
4. implement 不自动复用 session — 需显式传 resume
5. ALLOW_ROOTS 默认仅 ~/projects, ~/work, ~/codex-claude
6. 旧 job 记录无 fingerprint/heartbeat_at

## 9. Codex 配置示例

```toml
[~/.codex/config.toml]
[mcp_servers.claude_delegate]
command = "node"
args = ["/absolute/path/to/codex-claude-delegate-mcp/dist/server.js"]
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

## 10. 数据存储

- Run logs: `.codex-claude-delegate/runs/<runId>.json`
- Sessions: `.codex-claude-delegate/sessions.json`
- Background jobs: `.codex-claude-delegate/jobs/<jobId>.json`
- Review gate: `.codex-claude-delegate/review-gate.json`
- Delegated worktrees: `.claude/worktrees/codex-delegated-<runId 前缀 8 位>/`
