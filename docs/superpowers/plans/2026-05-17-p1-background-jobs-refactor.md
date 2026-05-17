# P1 Background Jobs Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the highest-risk remaining `src/claude-cli.ts` bloat by extracting background job lifecycle behavior into a focused module without changing MCP tool behavior.

**Architecture:** Keep `src/claude-cli.ts` as the public orchestration surface, but move background job state directory resolution, job summaries, duplicate fingerprints, wait metadata, stale-state decisions, detached runner startup, and queue/list/wait/cancel/cleanup APIs into `src/background-jobs.ts`. Keep Claude execution functions (`runClaudeQuery`, `runClaudeReview`, `runClaudeImplement`, `runClaudeApply`, `runClaudeCleanup`) in `src/claude-cli.ts` for this slice to avoid a broad circular refactor.

**Tech Stack:** TypeScript ESM, Zod schemas, Vitest with mocked process/filesystem boundaries.

---

## 1. 背景和目标

用户问题：上一轮审查指出 `src/claude-cli.ts` 是近 4,000 行的巨型模块，职责混杂，维护成本高。

当前行为：后台 job 的队列、状态摘要、等待语义、runner 启动、取消、清理等逻辑和 Claude CLI 执行逻辑、run log、review gate、worktree 逻辑交织在同一个文件中。

目标行为：
- 后台 job 相关公共函数仍从 `src/claude-cli.ts` 导出，外部调用路径不变。
- 后台 job 的内部实现迁移到 `src/background-jobs.ts`，并由该模块拥有 `CODEX_CLAUDE_BACKGROUND_STATE_DIR` 的解析、`JobStore` 创建、job 摘要、wait/stale/next action、detached runner 启动、list/get/wait/cancel/cleanup。
- `src/job-runner.ts` 不再重复定义 background state dir 解析，改用共享导出。
- 现有测试行为不变，新增或调整测试证明抽取后仍能处理 duplicate、runner 启动失败、payload validation 失败、waiting 非 timed_out、cancel 和 cleanup。

本次不做：
- 不重构 run log、review gate、worktree apply/cleanup、Claude CLI spawn option 创建。
- 不把 `executeBackgroundJob` 移出 `src/claude-cli.ts`，因为它依赖各类执行函数，留到下一切片处理。
- 不修改 npm 发布、安装、卸载流程。
- 不手工编辑 `dist/`。

## 2. 文件影响范围

`src/background-jobs.ts`
- 新增。负责 background job lifecycle helper 和 public background APIs。
- 导出 `JOB_STATE_DIR_ENV`、`getBackgroundStateDir`、`getJobStore`、`toJobSummary`、`createTaskFingerprint`、`buildWaitMetadata`、`startJobHeartbeat`、`summarizeBackgroundResult`、`getBackgroundWorktreeName`、`enqueueBackgroundJob`、`startBackgroundReview`、`startBackgroundQuery`、`startBackgroundImplement`、`startBackgroundApply`、`startBackgroundCleanup`、`listBackgroundJobs`、`getBackgroundJobResult`、`waitForBackgroundJob`、`cancelBackgroundJob`、`cleanupBackgroundJobs`。

`src/claude-cli.ts`
- 修改。移除已迁移的 background job helper 实现，改为从 `src/background-jobs.ts` 导入并重新导出需要保持兼容的函数。
- 保留 `executeBackgroundJob` 和具体 Claude operation 执行函数。

`src/job-runner.ts`
- 修改。复用 `getBackgroundStateDir`，删除重复实现。

`tests/background-jobs.test.ts`
- 新增或从 `tests/claude-cli.test.ts` 拆出 background job 单元测试，覆盖新模块直接导出行为。

`tests/claude-cli.test.ts`
- 修改。只保留需要通过 `claude-cli` 集成路径验证的测试；必要时更新导入路径。

`plugins/codex-claude-delegate/server/server.js` 与 `plugins/codex-claude-delegate/server/job-runner.js`
- 只能由 `npm run build:plugin` 生成更新。

不应修改：
- `dist/` 不允许手工编辑。
- `package.json`、`package-lock.json` 不应变化，除非测试命令证明构建脚本需要它们，本计划不需要。
- 用户本机 Codex/Claude 配置不应被读取或写入。

## 3. 正向验收用例

场景 A：后台 review job 正常入队
输入：`enqueueBackgroundJob({ cwd: repo, type: "review", payload: { cwd: repo, task: "review this" } })`
预期：
- 返回 `job.status = "queued"`。
- 返回 `job.pid` 为 detached runner pid。
- 持久化 job record 包含同一个 pid。
- spawn 参数仍指向 `job-runner.js <job_id>`。

场景 B：detached runner 启动后立刻退出
输入：spawn mock 在启动 grace window 内 emit `exit(1)`
预期：
- 入队函数返回 `job.status = "failed"`。
- 持久化 record `status = "failed"`。
- `error` 包含 `exited during startup`。

场景 C：等待中的 running/queued job
输入：`waitForBackgroundJob({ cwd, job_id })`，job 仍为 active
预期：
- `waiting = true`。
- `timed_out = false`。
- summary 包含不要重复本地执行的提示。
- next action 只建议继续等待/查看同一 job。

场景 D：terminal job 读取结果
输入：`waitForBackgroundJob({ cwd, job_id })`，job 为 succeeded 且 result_status 为 partial
预期：
- `waiting = false`。
- `timed_out = false`。
- 返回 job summary 和 result。

场景 E：取消 running job
输入：running job 带 pid，调用 `cancelBackgroundJob`
预期：
- 调用 `process.kill(pid, "SIGTERM")`。
- record status 变为 `cancelled`。
- summary 为 `Cancelled by user`。

## 4. 负向验收用例

场景 F：重复 fingerprint
输入：已有 active job 和新 job 的 cwd/type/payload fingerprint 相同
预期：
- 不 spawn 新 runner。
- 返回现有 job。
- `do_not_start_duplicate_job = true`。

场景 G：persisted payload schema invalid
输入：query job payload 缺少 `task`
预期：
- `executeBackgroundJob(jobId)` reject，错误包含 payload/schema/validation。
- job record 被标记为 failed。
- 不调用 Claude spawn。

场景 H：取消不存在的 job
输入：`cancelBackgroundJob({ cwd, job_id: "missing" })`
预期：
- 返回 `cancelled = false`。
- error 说明 job not found。
- 不调用 `process.kill`。

场景 I：清理旧 terminal jobs
输入：old succeeded、old cancelled、running 三个 job，`cleanupBackgroundJobs({ dry_run: false, limit: 1 })`
预期：
- 只删除一个 terminal job。
- running job 不被删除。
- limit 被尊重。

场景 J：state dir env 兼容
输入：
- 设置 `CODEX_CLAUDE_BACKGROUND_STATE_DIR`
- 或只设置 `CODEX_CLAUDE_RUN_LOG_DIR`
预期：
- `getBackgroundStateDir()` 优先使用 background env。
- run log env 存在时返回其 dirname。
- 两者都不存在时返回 `process.cwd()/.codex-claude-delegate`。

## 5. 禁止事项

- 不允许改变 MCP 工具返回字段名或含义。
- 不允许把 `waiting` 再等同于 `timed_out`。
- 不允许用真实 Claude CLI、真实 Codex 配置或用户 home 目录做测试依赖。
- 不允许手工编辑 `dist/`。
- 不允许让 `src/background-jobs.ts` 反向导入 `src/claude-cli.ts`。
- 不允许在此切片重命名 MCP tools 或 schema wire fields。

## 6. 测试计划

`tests/background-jobs.test.ts`
- `resolves background state dir from explicit env before run log env` 覆盖场景 J。
- `enqueues a detached background job and records launch metadata` 覆盖场景 A。
- `marks a background job failed when the detached runner exits during launch` 覆盖场景 B。
- `returns a waiting status while a background job stays running` 覆盖场景 C。
- `returns a waiting status while a background job stays queued` 覆盖场景 C。
- `waits for a background job that is already terminal` 覆盖场景 D。
- `lists, reads, and cancels background jobs` 覆盖场景 E。
- `returns existing active duplicate job without spawning` 覆盖场景 F。
- `dry-runs and removes old terminal background jobs without touching running jobs` 覆盖场景 I。

`tests/claude-cli.test.ts`
- `marks background job failed when persisted payload fails schema validation` 保留在 `claude-cli` 集成路径，覆盖场景 G。
- `accepts implement background payload with instruction_files during schema validation` 保留在 `claude-cli` 集成路径，防止上一轮 schema 修复回退。

运行命令：
- `npx vitest run tests/background-jobs.test.ts tests/job-runner.test.ts tests/claude-cli.test.ts`
- `npm run typecheck`
- `npm run build`
- `npm test`
- `npm run build:plugin`
- `npm run check:plugin`
- `npm run audit:docs`

## 7. 文档一致性检查

- README 或 plugin docs 如果提到后台 job、wait、cancel、cleanup，抽取后行为必须仍一致。
- 本次纯内部重构如无用户可见行为变化，不新增用户文档承诺。
- 若 `npm run audit:docs` 因接口导出变化失败，必须修复代码或文档生成输入，不能跳过。

## 8. 交付要求

实现者完成后必须汇报：
- 修改了哪些文件。
- 哪些 `src/claude-cli.ts` 函数被迁移，哪些刻意保留。
- 每个验收场景 A-J 对应的测试。
- 已运行的测试/构建命令和结果。
- 是否还有未覆盖风险。
- 是否更新了插件 bundle。

