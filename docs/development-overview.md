# codex-claude-delegate-mcp 开发概况报告（更新）

> 上一版: 2026-05-06 (dedup + heartbeat + stale + tool surface)
> **本次更新: 2026-05-07 (plugin runtime bundling + repo cleanup + onboarding)**
> 变更标记: `[NEW]` / `[CHANGED]` / `[REMOVED]` 表示相对于上一版的增减或修改

---

## 1. 项目身份

| 属性 | 值 |
|------|-----|
| **项目名** | `codex-claude-delegate-mcp` |
| **版本** | `0.1.0` |
| **类型** | ES Module |
| **入口** | `plugins/codex-claude-delegate/server/server.js`（插件 runtime） / `dist/server.js`（源码构建） |
| **定位** | MCP stdio server，使 Codex CLI 可通过插件将任务委托给 Claude Code |
| **核心思路** | Codex 规划与验收，Claude 执行；后台作业模型；隔离 git worktree；[NEW] 插件安装即用，无需本地构建 |

---

## 2. 代码规模与结构

### 2.1 文件统计

```
src/                 8 个 TypeScript 源文件
tests/               10 个 Vitest 测试文件 [CHANGED: 原9个, 新增 plugin-runtime.test.ts]
plugins/             插件包 ( .mcp.json / server runtime / skills / hooks )
scripts/             工具脚本 (check-plugin.mjs) [NEW]
docs/                文档 (onboarding-plan.md)
dist/                构建产物（仅开发用）
```

### 2.2 [REMOVED] 已从仓库移除的文件

| 文件 | 原因 |
|------|------|
| `AGENTS.md` | 个人 agent 指令 |
| `CLAUDE.md` | 个人 Claude 指令 |
| `SPEC.md` | 过时内部设计文档 |
| `debug/` (14 个文件) | 开发调试脚本 |
| `.agents/` (2 个文件) | Codex 本地插件副本（源在 `plugins/`） |

### 2.3 [NEW] 插件运行时构建

`plugins/codex-claude-delegate/server/` 目录包含通过 esbuild bundle 的自包含 MCP runtime：

| 文件 | 大小 | 来源 | 说明 |
|------|------|------|------|
| `server.js` | ~1.0 MB | esbuild bundle `src/server.ts` | 插件 MCP server 入口 |
| `job-runner.js` | ~624 KB | esbuild bundle `src/job-runner.ts` | 后台 detached worker |

构建命令: `npm run build:plugin`，验证命令: `npm run check:plugin`。

### 2.4 源码模块（不变）

```
src/
├── server.ts       # MCP stdio 入口，18 个工具注册与分发
├── claude-cli.ts   # Claude CLI 启动、后台作业管理、结果观测、apply 范围检查
├── jobs.ts         # JobStore: 文件系统作业持久化、去重、心跳
├── job-runner.ts   # Detached worker 进程入口
├── session.ts      # 会话持久化与复用策略
├── guard.ts        # 安全: cwd 校验、env 清理、递归防护
├── schema.ts       # 类型定义、Zod 校验、JSON Schema、prompt 构建器
└── codex-config.ts # Codex allow_roots 配置读写
```

### 2.5 [NEW] NPM Scripts 变更

| 命令 | 功能 | 变更 |
|------|------|------|
| `npm run build` | tsc 编译到 `dist/` | 不变 |
| `npm run build:plugin` | esbuild bundle 到 `plugins/.../server/` | **新增** |
| `npm run check:plugin` | 验证插件 runtime 完整性 | **新增** |
| `npm run test` | vitest run | 不变 |
| `npm run typecheck` | tsc --noEmit | 不变 |

### 2.6 依赖变更

| 依赖 | 版本 | 变更 |
|------|------|------|
| `esbuild` | ^0.25.0 (devDependency) | **新增** |

运行时依赖不变: `@modelcontextprotocol/sdk`, `zod`。

---

## 3. [CHANGED] 插件包结构

```
plugins/codex-claude-delegate/
├── .mcp.json                          # MCP server 配置 (command: node, args: [./server/server.js])
├── .codex-plugin/plugin.json          # Codex 插件主配置（技能、hooks、界面配置）
├── .claude-plugin/plugin.json         # Claude 兼容元数据（保留）
├── server/
│   ├── server.js                      # [NEW] esbuild bundle MCP server
│   └── job-runner.js                  # [NEW] esbuild bundle background runner
├── skills/
│   ├── claude-delegate.md             # 默认工作流指引
│   ├── claude-rescue.md               # 高级工具指引
│   └── claude-review.md               # 审查指引
└── hooks/
    ├── hooks.json                     # Stop hook 配置 (${CLAUDE_PLUGIN_ROOT})
    └── review-gate-stop.mjs           # Stop hook 实现
```

### 3.1 [CHANGED] .mcp.json 路径

从旧版依赖 `${CLAUDE_PLUGIN_ROOT}` 改为固定相对路径：

```json
{
  "mcpServers": {
    "claude_delegate": {
      "command": "node",
      "args": ["./server/server.js"],
      "cwd": "."
    }
  }
}
```

后台 job runner 路径由 server runtime 在同目录查找 `job-runner.js`。hooks 仍依赖 `${CLAUDE_PLUGIN_ROOT}`。

---

## 4. [CHANGED] 完整类型系统

（核心类型未变，schema 无新增字段。以下仅列出当前所有关键类型。）

```
BackgroundJobStaleState         — "fresh" | "stale_candidate" | "stale"
BackgroundJobEnqueueResult      — 入队去重结果信封
BackgroundJobSummary            — last_wait_at, heartbeat_at, fingerprint, ...
BackgroundJobRecord             — extends BackgroundJobSummary + payload, result
ClaudeJobWaitResult             — do_not_start_duplicate_job, age_ms, heartbeat_age_ms, stale_state, poll_too_soon, remaining_delay_ms, next_allowed_poll_at
ClaudeResultResult              — do_not_start_duplicate_job?, next_actions
ClaudeWorkspaceStatusResult     — do_not_start_duplicate_job?, next_actions?, attention_items
ClaudeTaskResult                — deduped?, do_not_start_duplicate_job?
```

---

## 5. MCP 工具矩阵（18 个，不变）

| 层次 | 工具 | 功能 |
|------|------|------|
| **Default** | `claude_setup` | 完整就绪检查 + configure_allow_root |
| | `claude_task` | 高层入口，按 mode=auto/read/review/write 路由 |
| | `claude_job_wait` | 轮询 + 过期检测 + 动态延迟 + 节流 |
| | `claude_result` | 解析最相关已完成 job/run + next_actions |
| | `claude_apply` | 预览/应用 worktree 变更 |
| | `claude_cleanup` | 清理 delegated worktree |
| **Advanced** | `claude_status/runs/run_inspect/workspace_status/review_gate/query/review/implement/jobs/job_result/job_cancel/job_cleanup` | 调试/精细控制 |

工具行为、输入输出 schema 均不变。

---

## 6. [CHANGED] 安装与上手路径

### 6.1 用户路径（插件优先）[NEW]

```
git clone → codex plugin marketplace add → /plugins 安装 → claude_setup → claude_task → ...
```

无需 `npm install` 或 `npm run build`，插件自带 bundle runtime。

### 6.2 维护者/开发路径

```
npm install → npm run build:plugin → npm run check:plugin → npm test → npm run typecheck
```

常规开发仍可使用 `npm run dev`（tsx 实时运行）或 `npm run build`（tsc 编译到 dist/）。

---

## 7. [NEW] 验证脚本

`scripts/check-plugin.mjs` (142 行) 在执行 `npm run check:plugin` 时验证：

1. `.mcp.json` 指向的 `server/server.js` 存在
2. background job runner (`server/job-runner.js`) 存在
3. plugin runtime 不被 `.gitignore` 忽略
4. Node 启动 runtime 文件时不出现缺失依赖加载错误

---

## 8. [CHANGED] 测试策略

### 8.1 测试框架（不变）
- Vitest v3.2.4, Node environment
- 匹配: `tests/**/*.test.ts`

### 8.2 测试覆盖

| 测试文件 | 测试数 | 变更 |
|----------|--------|------|
| `guard.test.ts` | 7 | 不变 |
| `server.test.ts` | 26 | 不变 |
| `schema.test.ts` | 16 | 不变 |
| `claude-cli.test.ts` | 45 | 不变 |
| `codex-config.test.ts` | 2 | 不变 |
| `review-gate.test.ts` | 1 | 不变 |
| `job-runner.test.ts` | 4 | 不变 |
| `jobs.test.ts` | 7 | 不变 |
| `job-wait.test.ts` | 11 | 不变 |
| `plugin-runtime.test.ts` | 1 | **[NEW]** |
| **总计** | **120** | (原 119，实际输出 122 — 含部分的 subtests 展开) |

`plugin-runtime.test.ts` 验证 `plugins/codex-claude-delegate/server/server.js` 和 `job-runner.js` 存在。

---

## 9. [CHANGED] 数据存储结构

（不变，但需注意路径区分）

| 类型 | 路径 | 归属 |
|------|------|------|
| Run logs | `.codex-claude-delegate/runs/<runId>.json` | 每个用户工作区 |
| Sessions | `.codex-claude-delegate/sessions.json` | 每个用户工作区 |
| Background jobs | `.codex-claude-delegate/jobs/<jobId>.json` | 每个用户工作区 |
| Review gate | `.codex-claude-delegate/review-gate.json` | 每个用户工作区 |
| Delegated worktrees | `.claude/worktrees/codex-delegated-<runId>/` | 每个用户工作区 |
| Plugin MCP entry | `plugins/codex-claude-delegate/server/server.js` | **[NEW]** 仓库追踪 |
| Plugin runner | `plugins/codex-claude-delegate/server/job-runner.js` | **[NEW]** 仓库追踪 |

卸载模型分为 global resources 和 workspace resources。Global resources 只处理一次；workspace resources 会按已知 workspace 分组扫描。已知 workspace 来源包括当前卸载仓库、`CODEX_CLAUDE_ALLOW_ROOTS`、配置根目录直接子目录中的 `.codex-claude-delegate/`、以及 state JSON 中记录的 `cwd` / `input.cwd` / `workspace_root` / `repo_root`。扫描是有界的：只检查明确配置的路径及其直接子目录，不递归扫整个磁盘，并跳过 `/`、`/tmp`、`/etc` 和用户 home 这类过宽根目录。

---

## 10. [CHANGED] .gitignore

```gitignore
node_modules/
.claude/
.codex-claude-delegate/
.debug-fixtures/
/dist/
*.tsbuildinfo
coverage/
goal.md
debug/                       # [NEW]
/.agents/*                   # [NEW]
!/.agents/plugins/           # [NEW] 保留 marketplace.json
!/.agents/plugins/marketplace.json  # [NEW]
/AGENTS.md                   # [NEW] 忽略根目录个人文件
/CLAUDE.md                   # [NEW]
```

注意：`plugins/codex-claude-delegate/server/*.js` 未被 `.gitignore` 忽略（被仓库追踪）。

---

## 11. 开发阶段

| Phase | 内容 | 状态 |
|-------|------|------|
| Phase 1 | 裸 MCP Server + One-shot 委托 | ✅ |
| Phase 2 | 会话复用 | ✅ |
| Phase 3.1 | Apply + Cleanup + 状态报告 | ✅ |
| Phase 3.2 | 资源控制 | ✅ |
| Phase 3.3 | 变更观测与作用域收敛 | ✅ |
| Phase 4 | 后台作业 + 高级工作流 | ✅ |
| Phase 4.x | Job 稳定性 (dedup/heartbeat/stale/throttle) | ✅ |
| Phase 4.y | Plugin runtime bundling + onboarding | **[NEW]** ✅ |
| | esbuild bundle server + job-runner | ✅ |
| | check:plugin 验证脚本 | ✅ |
| | .mcp.json 相对路径 | ✅ |
| | 仓库清理（移除个人/开发文件） | ✅ |
| | README 插件优先重写 | ✅ |

---

## 12. 已知限制（更新）

1. 无实时双向通信
2. 每次 Claude 调用冷启动 ~2-5s
3. 不自动清理 worktree — 卸载 dry-run 会跨已知 workspace 报告残留，但仍需按 workspace 执行 `claude_cleanup`
4. 旧 job 记录无 fingerprint/heartbeat_at
5. Stale 检测仅为建议，不自动杀进程
6. **[NEW]** Bundle 无 source map（调试用 `npm run dev` 或 `dist/` 产物）
7. **[NEW]** 插件 runtime 约 1.6 MB 总提交大小
8. **[NEW]** hooks 仍依赖 `${CLAUDE_PLUGIN_ROOT}`（.mcp.json 已改为相对路径）

---

## 13. [CHANGED] Git 提交历史

```
0819d53 更新文件
2d7170a 更新
1ac3192 修复排队问题
1a450c0 修复插件问题
af9a97c 更新文档
773d53f 更新安装流程
f40ce65 更新文档
4cc06a4 更新
c72a002 更新文档
2c9de2c 更新readme
8b9a4dc feat: package plugin runtime for onboarding
76f6902 chore: strip personal and dev-only files
bbcb905 docs: rewrite README for user-facing conciseness
5883ba1 chore: update last_wait_at and files semantics tests
df5c762 fix: throttle waits and clarify task files
0712581 fix: throttle background job polling
```

---

## 14. 当前未提交文件

```
?? docs/project-review-prioritized.md
```

单文件 untracked，与项目无关的临时分析文档。

---

## 15. Tool-contract safety rules

- `claude_task` must not expose `max_turns`; explicit turn caps belong only to Advanced / Debug tools.
- `claude_apply` is preview-first. Non-preview apply is a main-workspace write and must require `confirmed_by_user=true`.
- `confirmed_by_user` is a pragmatic service-side guard against accidental non-preview apply. It is model-supplied and not cryptographic proof of human intent, so docs and agent instructions must still require explicit user approval before setting it.
- Workflow `next_actions` must not suggest direct non-preview apply.
