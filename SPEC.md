# Spec: Codex → Claude Code Task Delegation

## 1. 目标

让 **Codex CLI 规划任务后，把执行工作委托给 Claude Code**，Codex 验收结果。

不做：两个 agent 实时双向聊天、Claude 主动向 Codex 发消息。

## 2. 背景调研

### 2.1 已有方案

| 项目 | Stars | 方向 | 活跃 | 结论 |
|---|---|---|---|---|
| `openai/codex-plugin-cc` | 17k | Claude → Codex | 官方维护 | 正向插件，参考其架构 |
| `raysonmeng/agent-bridge` | 111 | 双向实时 | 活跃 | 实时双向桥（Claude Code Channels），非任务委托型 |
| `Dunqing/claude-codex-bridge` | 2 | 双向 MCP | 停滞 | 设计思路可参考，成熟度极低 |
| `AlessioZazzarini/claude-codex-collab` | 15 | Claude → Codex | 停滞 | 方向相反，非 Codex → Claude |
| `Leonard013/BigBrain` | 1 | Claude → Codex | 停滞 | 多模型 advisor，非反向委托 |

### 2.2 `codex-plugin-cc` 架构（参考）

```
Claude Code
  └─ Hooks (SessionStart/Stop)
       └─ Bash → codex-companion.mjs
            └─ Codex App Server (JSON-RPC over stdin/stdout)
                 └─ thread/start, turn/start, review/start
```

### 2.3 本项目的对称架构

```
Codex CLI
  └─ MCP Client (Codex 原生支持)
       └─ stdio ── codex-claude-delegate-mcp (Node.js MCP Server)
            └─ spawn("claude", argsArray) → claude -p
                 └─ --worktree, --json-schema, 结构化返回
```

### 2.4 关键决策：任务委托 vs 实时协作

- **任务委托（本项目选择）**：Codex 调一个 tool → Claude 子进程跑完 → 返回结果。简单、可控、不依赖实验特性。
- **实时协作**：两个 agent 进程同时运行，通过 WebSocket/Channels 互通。需要 Claude Code Channels（research preview）。参考 `agent-bridge`。

### 2.5 CLI 路径 vs Agent SDK 路径

| | `claude -p` | Claude Agent SDK |
|---|---|---|
| 认证 | 复用本地 Claude 订阅 | 需要 Anthropic API key |
| 控制粒度 | CLI flags | `ClaudeAgentOptions` 全量 |
| Session 管理 | `--resume` flag | `list/delete/fork/tag/resume` + 自定义 store |
| 流式输出 | `--output-format stream-json` | async iterator |
| 适合场景 | MVP / 个人使用 | 产品化 / 稳定分发 |

**Phase 1 用 CLI 路径**，复用本地订阅、快速验证。

## 3. 架构

### 3.1 核心链路

```
Codex 规划任务
  ↓ 调用 MCP tool
MCP server (stdio)
  ↓ validateCwd / checkRecursion / sanitizeEnv
spawn("claude", ["-p", "-w", ..., "--json-schema", ...])
  ↓ Claude 在隔离 worktree 中执行
解析 structured_output
  ↓ git diff --name-only / --stat (server_observed)
返回 { claude_report, server_observed } 给 Codex
  ↓
Codex 验收 diff，决定是否 apply
```

### 3.2 模块分工

```
src/
├── server.ts       # MCP server 入口，stdio transport，4 个 tool 路由
├── claude-cli.ts   # spawn claude -p 封装，3 种运行模式（query/review/implement）
├── guard.ts        # 安全：cwd 校验、env 清理、递归防护、exec 工具函数
└── schema.ts       # 类型定义、JSON Schema、结构化输出类型、prompt 构建器
```

## 4. MCP Tools

### 4.1 `claude_status`

检查 Claude Code CLI 可用性、认证状态、git worktree 支持。

- **入参**: `{ cwd: string }`
- **出参**: `ClaudeStatusResult { claude_available, claude_version, auth_status, git_available, worktree_capable, cwd_valid, cwd_is_git_repo, errors[] }`
- **不改文件**

### 4.2 `claude_query`

问 Claude 只读问题。Claude 可读文件、跑安全 git 命令，不可修改。

- **入参**: `{ task: string, cwd: string, timeout_sec?: number }`
- **出参**: `ClaudeReport`（通过 `--json-schema` 约束）
- **工具**: `--tools "Read,Glob,Grep,Bash"`
- **maxTurns**: 4
- **不改文件**

### 4.3 `claude_review`

让 Claude review 代码变更（diff 或当前工作区状态）。

- **入参**: `{ task: string, cwd: string, diff?: string, files?: string[], timeout_sec?: number }`
- **出参**: `ClaudeReport`
- **工具**: `--tools "Read,Glob,Grep,Bash"`
- **maxTurns**: 6
- **不改文件**

### 4.4 `claude_implement`

让 Claude 在隔离 worktree 中实现代码变更，运行测试，返回结构化结果 + 实际 diff。

- **入参**: `{ task: string, cwd: string, files?: string[], constraints?: string[], timeout_sec?: number }`
- **出参**: `{ claude_report: ClaudeReport, server_observed: ServerObserved }`
- **工具**: `--tools "Read,Glob,Grep,Edit,Write,Bash"`
- **maxTurns**: 8
- **隔离**: `--worktree codex-delegated-<runId>`
- **会改文件**（仅在 worktree 内）

### 4.5 结构化返回类型

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
  changed_files: string[];       // 实际 git diff --name-only
  diff_stat: string;              // 实际 git diff --stat
  diff_name_only: string;
  worktree_path?: string;
}
```

## 5. 安全设计

### 5.1 三层工具控制

Claude CLI 的三个 flag 职责不同，不能混淆：

| Flag | 作用 |
|---|---|
| `--tools` | **限制 Claude 能看到/使用哪些工具**（工具白名单） |
| `--allowedTools` | **哪些调用自动通过，不再询问权限**（免审批列表） |
| `--disallowedTools` | **哪些工具/pattern 彻底禁用**（硬禁止） |

正确的组合：

```bash
--tools "Read,Glob,Grep,Edit,Write,Bash" \
--allowedTools "Read" "Glob" "Grep" "Edit" "Write" "Bash(git status)" ... \
--disallowedTools "Bash(rm *)" "Bash(sudo *)" "Bash(curl *)" ...
```

### 5.2 非交互模式

```bash
--permission-mode dontAsk
```

`claude -p` 是非交互模式，`dontAsk` 确保遇到未批准的工具调用时自动拒绝而非卡住。

### 5.3 递归防护

```
BRIDGE_DEPTH 环境变量:
  0 → 正常允许委托
  1 → 允许被委托的 agent 工作，但禁止再次委托
  ≥2 → MCP server 直接拒绝启动
```

MCP server 启动时检查，spawn Claude 时传 `BRIDGE_DEPTH + 1`。

### 5.4 cwd 校验

```ts
validateCwd(raw):
  1. realpath 解析（防 ../ 越界）
  2. 必须在 ALLOW_ROOTS 白名单内
  3. 必须是目录
  4. implement 额外要求是 git 仓库
```

### 5.5 环境变量清理

只透传 `PATH, HOME, SHELL, LANG, LC_ALL, TERM, USER, TMPDIR, TEMP, TMP, NODE_ENV`。

过滤所有含 `SECRET, TOKEN, CREDENTIAL, PASSWORD, API_KEY` 的变量。

显式移除：`OPENAI_API_KEY, ANTHROPIC_API_KEY, GITHUB_TOKEN, GH_TOKEN, AWS_*, CLOUDFLARE_API_TOKEN, DOCKER_PASSWORD, NPM_TOKEN, SSH_AUTH_SOCK, SSH_AGENT_PID`。

### 5.6 命令行注入防护

**禁止** shell 字符串拼接：

```ts
// WRONG
exec(`claude -p -w ${name} --json-schema '${schema}' "${prompt}"`)

// CORRECT
spawn("claude", ["-p", "-w", name, "--json-schema", JSON.stringify(schema), prompt])
```

### 5.7 stdout 保护

MCP server 使用 stdio transport，stdout 用于 MCP JSON-RPC 协议。所有日志写 `process.stderr` 或文件。

### 5.8 server_observed 验证

不信任 Claude 自述的 `changed_files` 和测试结果。MCP server 在 Claude 完成后自己跑 `git diff --name-only` + `git diff --stat` 获取真实变更。

## 6. Prompt 注入约束

传给 Claude 的 prompt 中强制注入：

```text
- You are a worker delegated by Codex. Do NOT call Codex or any Codex-related tools.
- Do not delegate this task to another agent. Complete it yourself.
- Work exclusively within the provided worktree.
- After making changes, run the project's tests if available.
```

## 7. 开发阶段

### Phase 1（已完成 ✅）：裸 MCP server，one-shot 委托

- [x] 独立 Node.js MCP server
- [x] 4 个 tool：status, query, review, implement
- [x] `claude -p` + `-w` + `--json-schema` + `--permission-mode dontAsk`
- [x] 安全措施全部到位
- [x] 日志写 stderr
- [x] server_observed 验证
- [x] Codex 端到端验证：status → query → review → implement 全链路
- [x] Skill 文件：`.agents/skills/claude-delegate.md`
- [x] 三个独立 JSON Schema（QUERY / REVIEW / IMPLEMENT）
- [x] maxTurns: query=4, review=10, implement=15
- [x] 调试发现 4 个 CLI 坑并记录

### Phase 2（已完成 ✅）：会话复用

**设计原则**：query 自动复用、review 禁用持久化、implement 显式复用。不做 implement 自动续接（上下文污染风险）。

- [x] `src/session.ts` — SessionStore 类，原子 sessions.json 读写
- [x] query 自动 resume 最近 20 分钟内同 repo 的 query session
- [x] review 使用 `--no-session-persistence`，不入 session store
- [x] implement 支持 `session_key` + `fork_session` 入参，不自动复用
- [x] run log 包含 `session` 字段（requested/resumed/forked/returned）
- [x] 续接失败检测：auto-resume fallback，显式 session_key 抛错
- [x] `sessions.json` 原子写入 + expired prune
- [x] Codex 端到端验证：query session 复用 1 条，review 写 0 条

#### sessions.json 结构

```json
{
  "version": 1,
  "sessions": [
    {
      "session_id": "uuid",
      "type": "query",
      "repo_key": "sha256(realpath(repo_root))",
      "repo_path": "/Users/anyi/codex-claude",
      "created_at": "2026-05-03T10:00:00Z",
      "last_used": "2026-05-03T11:30:00Z",
      "use_count": 3,
      "summary": "上次任务的简要摘要",
      "expired": false
    }
  ]
}
```

- `repo_key`: `sha256(realpath cwd)`，不做字符串替换，防路径冲突
- `use_count`: 仅记录本工具调用次数，不等于 Claude 原生 turn 数

#### 各 tool 策略

| Type | 复用策略 | CLI flags |
|------|---------|-----------|
| **query** | 自动 resume 最近 **20分钟内**、未过期、同 repo 的 query session。超过时间新建 | `-p -r <session_id>` |
| **review** | 不复用，不写入 session store | `-p --no-session-persistence` |
| **implement** | 仅当用户显式传 `session_key` 或 `fork_session` 时 resume。不传则新建 session 并记录 session_id，但不自动复用 | `-p -r <session_id>` 或 `-p -r <session_id> --fork-session` |

#### 新增入参（claude_implement）

```ts
// 扩展 ClaudeImplementInput
session_key?: string;    // resume 指定 session
fork_session?: boolean;  // 配合 session_key 使用: fork 不污染原 session
```

- `session_key` = 要 resume 的 Claude `session_id`
- `fork_session` = resume 时加 `--fork-session` flag
- 不传 `session_key` 时：新建 session，记录返回的 `session_id` 到 sessions.json，但永不自动复用

#### 新增模块

**src/session.ts** — 会话持久化存储：

```ts
class SessionStore {
  constructor(path: string);
  getRecent(repoKey: string, type: string, withinMinutes: number): Session | null;
  upsert(sessionId: string, type: string, repoKey: string, repoPath: string): void;
  markExpired(sessionId: string): void;
  prune(): void;            // 删除过期 >24h 的 session
  getAll(): Session[];
}
```

- 原子写入：`writeFile` + `rename` 防并发损坏
- 只在 `spawnClaude` 返回后写入（从 stdout 的 `session_id` 字段提取）

#### run log 扩展

每条 run log 新增 `session` 字段：

```json
{
  "session": {
    "requested_session_id": "...",
    "resumed": true,
    "forked": false,
    "returned_session_id": "..."
  }
}
```

#### 续接失败处理

当 `-r <session_id>` 返回以下错误时：
- "session not found"
- "not found"
- "expired"

策略按 resume 类型区分：

| 场景 | 处理 |
|------|------|
| **query 自动 resume** | 标记 session `expired: true`，fallback 到无 resume 新 session（静默恢复） |
| **implement 显式 session_key** | 标记 session `expired: true`，抛出错误（用户明确指定的 session 不存在应报错） |

#### 不做的功能

- ❌ `--session-id <repo_key>` — CLI 要求 valid UUID，不能用 repo_key
- ❌ implement 自动复用 — 上下文污染风险高
- ❌ `sessions/<session-id>.log` 独立日志目录 — 现有 `runs/` 目录已够用
- ❌ "最近 ~3 个 session 内同类任务则续接" — 定义不清，第一版不做

#### 完成标准

- [x] `npm run build` 通过
- [x] `debug/mcp-test.ts` 能证明 query 第二次调用使用 `-r`
- [x] run log 中包含 `session` 字段（requested_session_id / resumed / forked / returned_session_id）
- [x] `sessions.json` 创建、更新、prune 正常
- [x] resume 失败时标记 `expired: true` 并自动 fallback

### Phase 3 第一阶段（已完成 ✅）：apply + cleanup + 状态报告

核心闭环：implement → review diff → apply → cleanup。implement 不自动清理 worktree，Codex 验收后再走 apply/cleanup。

- [x] `claude_apply` — worktree diff → git apply --check → git apply → 可选 cleanup
- [x] `claude_cleanup` — 扫描残留 worktree，dry-run 模式，`git worktree remove`
- [x] `claude_status` 扩展 — `delegated_worktrees_count`, `delegated_worktrees[]`, `stale_worktrees_count`
- [x] apply 路径校验限定在 `.claude/worktrees/codex-delegated-*`
- [x] patch 文件临时写入 `.claude/apply-<runId>.patch`，apply 后清理
- [x] `npm run build` + `debug/mcp-test.ts` 通过

#### claude_apply

新增工具，将 worktree 中的 diff 应用到主工作区。

```ts
入参 {
  cwd: string;
  worktree_path: string;           // 限定 .claude/worktrees/ 下
  cleanup?: boolean;               // apply 成功后自动清理 worktree
}

行为 {
  1. 校验 cwd 和 worktree_path 必在 .claude/worktrees/codex-delegated-*; 确认目录存在
  2. 检查主工作区被影响文件无本地未提交变更（git status --short），有冲突则拒绝
  3. 收集变更文件列表：git diff --name-status -- src/（区分 M/A/D）
  4. 对 M/A 文件：直接复制 worktree → 主工作区（避免 git apply patch 解析问题）
  5. 对 D 文件：从主工作区删除对应文件
  6. cleanup=true → git worktree remove --force .claude/worktrees/<name> + git worktree prune
  7. 返回 applied_files（实际成功列表）、diff_stat、cleanup_performed、conflicts[]
}
```

#### claude_cleanup

新增工具，清理残留 worktree。

```ts
入参 {
  cwd: string;
  older_than_hours?: number;       // 只清理超过 N 小时的 worktree
  dry_run?: boolean;               // 默认 true，先返回待清理列表
}

行为 {
  1. 只处理 .claude/worktrees/codex-delegated-*
  2. dry_run=true 返回待清理列表但不执行
  3. git worktree remove --force .claude/worktrees/<name>
  4. 失败时报告原因不 rm -rf 强制删除
}
```

#### claude_status 扩展

新增字段：

```json
{
  "delegated_worktrees_count": 2,
  "delegated_worktrees": ["codex-delegated-xxx", "codex-delegated-yyy"],
  "stale_worktrees_count": 0
}
```

### Phase 3 第二阶段：资源控制

- `max_cost_usd`: 通过 `--max-budget-usd` flag 传递给 Claude CLI
- `max_changed_files`: 在 `observeResult()` 后检查，超限返回风险状态但不自动删除 worktree
- `idle_timeout_sec`: 暂缓，除非遇到真实卡死问题

### Phase 4：打包为 Codex Plugin

```
.codex-plugin/
├── plugin.json
├── skills/
│   ├── claude-delegate.md
│   ├── claude-review.md
│   └── claude-rescue.md
├── mcp-server/
│   └── (当前项目)
└── hooks/
    └── hooks.json
```

## 8. 调试中发现的 CLI 坑

### 8.1 `--json-schema` 参数顺序 Bug

Claude CLI 的 `--json-schema` 必须放在 `--allowedTools` 和 `--disallowedTools` **之后**，且必须是 prompt 之前的最后一个 flag。如果放在之前，CLI 会把后续的 `--allowedTools` 等 flag 当作 schema 值的一部分消费掉，导致 "Input must be provided" 错误。

正确的参数顺序：
```
-p -w <name> --permission-mode --tools --max-turns --output-format
  --allowedTools ... --disallowedTools ... --json-schema <schema> <prompt>
```

### 8.2 `maxTurns` 不宜低于 15

implement 模式需要读文件、编辑、运行构建等多项操作。`maxTurns: 8` 时 Claude 往往未完成任务就达到上限，退出码为 1 (`error_max_turns`)。但此时 stdout 中仍有有效的结构化输出，不应直接丢弃。

修复：implement maxTurns → 15；非零退出时仍尝试解析 stdout 中的 structured_output。

### 8.3 `claude auth status` 返回 JSON

CLI 的 `claude auth status` 返回 `{"loggedIn": true, "authMethod": "oauth_token", ...}`，不是纯文本 "Logged in"。字符串匹配 `"Logged in"` 会失败，需用 `JSON.parse`。

### 8.4 三个工具需要三个不同的 JSON Schema

最初三个工具共用 `RESULT_SCHEMA`（面向 implement 的 status/summary/changed_files/tests/risks），导致 query 的 `summary` 字段承载不了完整答案。已拆分为：
- `QUERY_SCHEMA` — `{ answer: string }`
- `REVIEW_SCHEMA` — `{ findings, recommendations, severity }`
- `IMPLEMENT_SCHEMA` — 完整的 status/summary/changed_files/commands_run/tests/risks/next_steps

## 10. 已知限制

1. **无实时双向通信**：Codex 不能中途给 Claude 发补充指令，只能等 Claude 跑完
2. **Claude 无等价 App Server**：没有 Codex 那样的 JSON-RPC 守护进程，每次都是新进程（冷启动 ~2-5s）
3. **worktree 清理**：Phase 1 不自动清理 worktree，残留需要手动 `rm -rf .claude/worktrees && git worktree prune`
4. **session 不复用**：Phase 1 每次 one-shot，无上下文复用
5. **Codex Plugin 未打包**：Phase 1 需手动配置 `~/.codex/config.toml`
6. **Codex 会绕过 claude_implement**：对于简单任务，Codex 倾向于自己编辑而非委托。需显式指令或 Skill 引导
7. **ALLOW_ROOTS 硬编码**：目前仅允许 `~/projects`、`~/work`、`~/codex-claude`，需手动修改 `guard.ts` 扩展白名单

## 11. Codex 配置示例

```toml
# ~/.codex/config.toml

[mcp_servers.claude_delegate]
command = "node"
args = ["/Users/anyi/codex-claude/dist/server.js"]
tool_timeout_sec = 600
startup_timeout_sec = 20
enabled_tools = ["claude_status", "claude_query", "claude_review", "claude_implement"]
```

## 12. 运行日志

运行日志写入 `.codex-claude-delegate/runs/<runId>.json`，包含：

- 请求参数
- Claude 返回的 structured_output
- server_observed（git diff 实际结果）
- 耗时
- 错误信息（如有）
