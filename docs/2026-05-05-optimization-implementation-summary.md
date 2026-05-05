# 2026-05-05 Optimization Implementation Summary

## 背景

本次修改基于 `docs/similar-projects.md` 和前续优化方案，重点不是重写架构，而是在现有 `Codex -> MCP server -> Claude Code -> worktree` 链路上补齐可观测性和闭环状态。

目标聚焦为三点：

- 增强 run log 可读性和可查询性
- 给 `claude_apply` 增加 preview 能力
- 让单次 `implement` 任务可以随着 `apply` / `cleanup` 演进出更明确的 lifecycle

## 已完成改动

### 1. 新增 `claude_runs` MCP 工具

位置：

- `src/server.ts`
- `src/schema.ts`
- `src/claude-cli.ts`

能力：

- 读取 `.codex-claude-delegate/runs/*.json`
- 返回近期运行摘要，而不是要求用户手动打开原始 JSON
- 支持按以下字段过滤：
  - `cwd`
  - `limit`
  - `type`
  - `status`
  - `worktree_name`

返回摘要字段包含：

- `run_id`
- `type`
- `status`
- `lifecycle`
- `cwd`
- `summary`
- `error`
- `worktree_path`
- `worktree_name`
- `requested_session_id`
- `returned_session_id`
- `started_at`
- `updated_at`

### 2. 新增 `claude_apply` preview 模式

位置：

- `src/schema.ts`
- `src/server.ts`
- `src/claude-cli.ts`

能力：

- `claude_apply` 现在支持 `preview: true`
- preview 模式会执行与正式 apply 相同的：
  - worktree 路径校验
  - implement log 读取
  - scope 校验
  - resource limit 校验
  - 主工作区冲突检测
  - planned changes 解析
- preview 不会修改主工作区

新增返回字段：

- `preview`
- `planned_changes`

`planned_changes` 目前按文件返回：

- `status`
- `file`

### 3. 给 run log 增加 lifecycle 派生

位置：

- `src/schema.ts`
- `src/claude-cli.ts`

新增 lifecycle 概念：

这些是当前 schema/摘要层可表示的 lifecycle 枚举；其中 `queued`、`running` 目前仍属于保留状态，尚未在实际 run log 写入链路中产出。

- `queued`
- `running`
- `success`
- `partial`
- `failed`
- `apply_blocked`
- `applied`
- `cleaned`
- `unknown`

当前实际已接入的主要派生规则：

- `apply` 失败 -> `apply_blocked`
- `apply` 成功且实际落地文件 -> `applied`
- `cleanup` 成功删除 worktree -> `cleaned`
- preview 成功目前会回写成 `success`
- `needs_user` 会折叠到 `partial`

### 4. 给 `claude_status` 增加 recent runs 摘要

位置：

- `src/server.ts`
- `src/schema.ts`
- `src/claude-cli.ts`

`claude_status` 现在除了环境检查外，还会返回最近 5 条 run 的摘要：

- `recent_runs.entries`
- `recent_runs.lifecycle_counts`

这样状态接口可以直接回答：

- 最近跑过哪些委托
- 这些委托当前大致处于什么阶段
- 最近几次委托里是否出现过 `apply_blocked`

### 5. 回写 implement 生命周期

位置：

- `src/claude-cli.ts`

新增行为：

- `claude_apply` 完成后，会找到对应的 implement run log，并回写 downstream 状态
- `claude_cleanup` 完成后，也会更新对应 implement run log

当前回写内容包括：

- `current_lifecycle`
- `previewed_at`
- `applied_at`
- `cleaned_at`
- `last_apply_run_id`
- `last_cleanup_run_id`

这样从 `implement` 视角再看 `claude_runs` 时，可以看到它不是停留在初始 `success`，而是会继续演进到：

- `applied`
- `cleaned`

## 新增或修改的文件

- `src/server.ts`
- `src/schema.ts`
- `src/claude-cli.ts`
- `tests/schema.test.ts`
- `tests/claude-cli.test.ts`
- `debug/test-runs-preview.ts`
- `README.md`

本次未处理但存在于工作区中的其他未跟踪内容：

- `docs/similar-projects.md`
- `docs/superpowers/`

## 测试与验证

### 单元与类型检查

已通过：

- `npm test`
- `npm run build`
- `npm run typecheck`

### 真实 MCP 调用验证

新增调试脚本：

- `debug/test-runs-preview.ts`

该脚本会真实启动 `dist/server.js`，通过 MCP JSON-RPC 验证以下链路：

1. `claude_runs`
2. `claude_status` 的 `recent_runs`
3. `claude_apply` preview
4. `claude_apply` 实际应用
5. `claude_cleanup` 实际清理
6. implement lifecycle 从 `success` 演进到 `applied`、`cleaned`

已通过：

- `npx tsx debug/test-runs-preview.ts`

## 当前收益

本次修改后，项目相比修改前有几个明显改进：

- 用户无需直接翻 run log JSON，就能通过 MCP 工具查看最近运行记录
- `claude_apply` 可以先 preview，再决定是否真正落地
- `claude_status` 不再只是“环境是否可用”，还能反映最近委托活动
- `implement` 任务具备更完整的闭环状态，而不是只停留在初始执行结果

## 剩余可继续推进的方向

下一步最合理的是继续强化“单次委托视角”的聚合信息，而不是继续堆新工具。

建议方向：

- 为 `implement` 记录增加更明确的 downstream 详情展示
- 在 `claude_runs` 中直接暴露最后一次 preview/apply/cleanup 的时间和结果
- 增加单个 run 的 inspect 详情接口，而不是只有列表摘要
- 进一步减少 README、状态文档、调试脚本之间的信息漂移
