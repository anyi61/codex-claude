# CLAUDE.md

本项目为一个基于 TypeScript 的 MCP stdio 服务器，让 Codex CLI 可以将查询、审查和实现任务委托给 Claude Code，在隔离的 git worktree 中执行。Codex 负责规划与验收；Claude 执行。本说明面向在此代码库中编写代码的 Claude Code。

## 命令

```bash
npm run build       # 编译 TypeScript（tsc）
npm run dev         # 通过 tsx 直接运行（无需编译步骤）
npm start           # 运行编译后的输出（node dist/server.js）
npm test            # vitest 运行全部 119 个测试（9 个测试文件）
npm run typecheck   # tsc --noEmit 类型检查
```

## 架构

`src/` 中的 8 个模块：

- **server.ts** — MCP stdio 入口点。注册 18 个工具（6 个 Default + 12 个 Advanced/Debug），分发请求，当 `BRIDGE_DEPTH >= 2` 时拒绝。
- **claude-cli.ts** — 核心逻辑：启动 `claude -p` 子进程、后台作业管理（入队/去重/心跳/过期检测/轮询节流）、apply 范围检查、结果观测。
- **jobs.ts** — `JobStore` 类，基于文件系统的后台作业持久化存储。支持 fingerprint 去重、heartbeat 刷新、last_wait_at 记录。
- **job-runner.ts** — Detached worker 进程入口，接收 job_id，反序列化作业记录后按类型路由执行。
- **session.ts** — `SessionStore` 类，管理 Claude 会话的持久化存储与复用策略。
- **guard.ts** — 安全与工具：`validateCwd`（realpath + allowRoots + git 检查）、`sanitizeEnv`（剥离密钥，设置 BRIDGE_DEPTH+1）、`checkRecursion`。
- **schema.ts** — 全部 TypeScript 接口、Zod 输入校验、3 个 JSON Schema（QUERY/REVIEW/IMPLEMENT）、提示词构建器。
- **codex-config.ts** — 读写 `~/.codex/config.toml` 中 allow_roots 配置。

## 后台作业模型

执行型入口（claude_task / claude_query / claude_review / claude_implement）默认入队为后台作业并快速返回 job_id。调用方应轮询 `claude_job_wait`：

- **去重**: 通过 sha256 fingerprint（cwd + type + mode + task + files + 会话控制）检测活跃重复任务，返回 `deduped=true` + `do_not_start_duplicate_job=true`。
- **心跳**: Running job 每 15s 刷新 `heartbeat_at`，不依赖 Claude stdout。
- **过期分类**: heartbeat_age > 90s → stale_candidate；> 300s 或 pid 不存活 → stale。
- **轮询节流**: 记录 `last_wait_at` + `last_wait_recommended_delay_ms`，过早轮询返回 `poll_too_soon=true` + `remaining_delay_ms` + `next_allowed_poll_at`，不刷新 `last_wait_at`。
- **动态延迟**: age < 30s → 10s, < 2min → 20s, < 10min → 45s, < 30min → 60s, else → 90s。stale_candidate → 30s。

## 工具面分类

| 分类 | 工具 |
|------|------|
| **Default**（6 个，默认启用） | `claude_setup`, `claude_task`, `claude_job_wait`, `claude_result`, `claude_apply`, `claude_cleanup` |
| **Advanced / Debug**（12 个，默认禁用） | `claude_status`, `claude_runs`, `claude_run_inspect`, `claude_workspace_status`, `claude_review_gate`, `claude_query`, `claude_review`, `claude_implement`, `claude_jobs`, `claude_job_result`, `claude_job_cancel`, `claude_job_cleanup` |

## 数据流（以 write 为例）

```
claude_task(mode=write, task="...", instruction_files=[...])
  → createTaskFingerprint() → findActiveByFingerprint() → 命中则 deduped
  → enqueueBackgroundJob() → spawn detached child
  → 返回 job_id + next_actions (claude_job_wait)
  → Codex 轮询: claude_job_wait(id) → { poll_too_soon?, recommended_delay_ms, stale_state, ... }
  → terminal: claude_result(job_id) → claude_apply(preview=true) → claude_apply(cleanup=true)
```

## 会话策略

query 自动 resume 最近 20 分钟内同 repo 的 query session；review 使用 `--no-session-persistence`；implement 仅当显式传入 `session_key`/`fork_session`/`resume_latest` 时恢复。

## 安全规则

1. **stdout 为 MCP 协议保留** — 所有日志写 `process.stderr` 或文件。`console.log` 会破坏 JSON-RPC 流。
2. **禁 shell 字符串拼接** — 始终 `spawn("claude", argsArray)`。
3. **环境清理** — 每次 spawn Claude 前调用 `sanitizeEnv()`，剥离密钥并传递 `BRIDGE_DEPTH + 1`。
4. **cwd 必须验证** — 操作前调用 `validateCwd()` 检查 allowRoots 白名单。
5. **`--json-schema` 必须是 prompt 前的最后一个参数** — 必须在 `--allowedTools/--disallowedTools` 之后。
6. **Never use `claude -p` `--max-turns` by default** — 仅用户显式传入时才添加。
