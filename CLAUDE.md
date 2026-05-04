# CLAUDE.md

本文件为 Claude Code（claude.ai/code）在此仓库中编写代码时提供指引。

## 项目概览

本 MCP 服务器允许 Codex CLI 将任务委托给 Claude Code。Codex 调用该服务器暴露的 MCP 工具；服务器通过安全约束启动 `claude -p`，并返回结构化结果。

第一阶段（一次性委托 + worktree 隔离）、第二阶段（会话复用）和第三阶段第 1 部分（应用、清理与状态查询）已完成。第三阶段第 2 部分（资源控制：`max_cost_usd` / `max_changed_files`）也已完成。Codex 配置位于 `~/.codex/config.toml`（`[mcp_servers.claude_delegate]`）。Codex 技能位于 `.agents/skills/claude-delegate.md`。完整规范见 `SPEC.md`。

会话策略：query 自动恢复近期会话，review 使用 `--no-session-persistence`，implement 仅在显式传入 `session_key` 时恢复会话。

## 命令

```bash
npm run build          # 编译 TypeScript（tsc）
npm run dev            # 通过 tsx 直接运行（无需编译步骤）
npm start              # 运行编译后的输出（node dist/server.js）
```

## 架构

`src/` 中的五个模块：

- **server.ts** — MCP stdio 入口点。注册 4 个工具，分发请求，当 `BRIDGE_DEPTH >= 2` 时拒绝。
- **claude-cli.ts** — 根据模式使用不同参数和 schema 启动 `claude -p`。`runClaudeQuery`（QUERY_SCHEMA，自动恢复，maxTurns=4），`runClaudeReview`（REVIEW_SCHEMA，`--no-session-persistence`，maxTurns=10），`runClaudeImplement`（IMPLEMENT_SCHEMA，worktree，显式 `session_key`，maxTurns=15，支持 `max_cost_usd` → `--max-budget-usd` 和 `max_changed_files` → `resource_limits`）。`runClaudeImplement` 现在会拒绝请求的 `files` 在主工作区中存在脏状态的情况。`observeResult()` 使用 `git status --porcelain=v1 -z` 加上基准提交差异（`base_commit..HEAD`）来获取已提交和未提交变更的真实情况，并在超出 `files` 时发出范围警告。`runClaudeApply` 同样使用实现运行日志中的基准提交/范围信号，并拒绝超出范围或超过限制的 worktree。非零退出码如果能产生有效的 stdout JSON，仍会被正常解析（处理 `error_max_turns` 情况）。
- **session.ts** — `SessionStore` 类，支持原子读写 `sessions.json`、`getRecent`（20 分钟窗口）、`upsert`、`markExpired`、`prune`。
- **guard.ts** — 安全相关：`validateCwd`（realpath + allowRoots + git 检查）、`sanitizeEnv`（剥离密钥，设置 BRIDGE_DEPTH=1）、`checkRecursion`、`execCapture` / `execStream`（安全 spawn 辅助函数）。ALLOW_ROOTS 默认为 `~/projects`、`~/work`、`~/codex-claude`；可通过 `CODEX_CLAUDE_ALLOW_ROOTS` 环境变量覆盖（冒号分隔的路径列表）。
- **schema.ts** — 三个 JSON Schema（`QUERY_SCHEMA`、`REVIEW_SCHEMA`、`IMPLEMENT_SCHEMA`）、TypeScript 接口、`SessionLog` 类型，以及包含反委托约束的提示词构建器。

## 调试工具

```bash
npx tsx debug/mcp-test.ts        # 完整的 MCP 协议测试：init → status → query
npx tsx debug/test-implement.ts  # 独立的 implement 测试（含 worktree）
```

运行日志默认出现在 `.codex-claude-delegate/runs/<uuid>.json` 中，或当设置了 `CODEX_CLAUDE_RUN_LOG_DIR` 时写入该目录（用于隔离调试测试）。

## 编辑此代码库时的关键规则

### stdout 为 MCP 协议保留

这是一个 stdio MCP 服务器。`console.log` / `process.stdout.write` 会破坏 JSON-RPC 流，导致 Codex ↔ MCP 连接中断。所有日志记录必须使用 `process.stderr` 或写入 `.codex-claude-delegate/runs/` 下的文件。

### 切勿使用 shell 字符串拼接来启动 claude

```ts
// 错误 — 存在命令注入风险
exec(`claude -p -w ${name} "${prompt}"`)

// 正确
spawn("claude", ["-p", "-w", name, prompt])
```

### --tools、--allowedTools 与 --disallowedTools 各不相同

- `--tools` — 硬性工具白名单（未列出的工具 Claude 甚至无法看到）
- `--allowedTools` — 自动批准列表（在非交互模式下无需权限提示）
- `--disallowedTools` — 硬性拦截（从上下文中完全移除）

`claude -p` 非交互模式需要全部三个参数：`--tools` 限制能力，`--allowedTools` 让 Claude 能够实际使用工具而不卡住，`--disallowedTools` 硬性拦截危险模式。始终搭配 `--permission-mode dontAsk` 使用。

### 启动 Claude 前必须清理环境

`sanitizeEnv()` 是 guard.ts 中的标准实现。任何新的启动路径都必须使用它。敏感变量（API 密钥、令牌、SSH agent）绝不能泄漏到 Claude 子进程中。

### BRIDGE_DEPTH 必须传递

每次启动 Claude 都必须通过 `sanitizeEnv()` 将 `BRIDGE_DEPTH` 加 1 后传入。MCP 服务器在深度 ≥ 2 时拒绝启动。这防止了 Codex → Claude → Codex → … 的递归循环。

### cwd 必须经过验证

在操作由用户提供的路径之前，始终调用 `validateCwd()`。它会解析符号链接、检查 allowRoots，对于 `claude_implement` 还会确认路径位于 git 仓库中（`--worktree` 必需）。

### --json-schema 必须是 prompt 前的最后一个参数

Claude CLI 有一个解析特性：除非将 `--json-schema` 放在位置参数 prompt 之前的最后一个参数位置，否则它会将其后的所有参数都作为其值。`spawnClaude` 中的参数顺序必须为：

```
-p -w <name> --permission-mode dontAsk --tools ... --max-turns ... --output-format json
  --allowedTools ... --disallowedTools ... --json-schema <schema> <prompt>
```

如果将 `--json-schema` 放在 `--allowedTools` 或 `--disallowedTools` 之前，CLI 会报告 "Input must be provided either through stdin or as a prompt argument"。
