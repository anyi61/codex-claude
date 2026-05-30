# codex-claude-delegate-mcp

通过本地 MCP 服务器，让 Codex CLI 将读取、审查、写入任务委托给 Claude Code 执行。

> 非官方项目：这不是 OpenAI 或 Anthropic 官方产品。它会在你的本机启动 Claude Code CLI，并允许 Claude 在受控 allowlist 内读取文件、运行命令、在隔离 git worktree 中写入。它不是强沙箱；只在你信任的本地仓库和可信 Claude CLI 路径中使用。
>
> 完整安全文档：[SECURITY.md](./SECURITY.md)

## 快速开始

```bash
npm install -g @anyi61/codex-claude-delegate-mcp
codex-claude setup --write
codex-claude doctor
```

`npx` 不是推荐安装路径：MCP server 需要稳定的可执行命令、PATH、版本和卸载行为；临时 `npx` 生命周期不适合作为 Codex 的长期 MCP 配置。

Ready means：

- Codex 配置中 `claude_delegate` 使用 `command = "codex-claude"`。
- 默认启用恰好 5 个工具：`claude_setup`、`claude_task`、`claude_result`、`claude_apply`、`claude_cleanup`。
- `tool_timeout_sec` 至少为 600，可以覆盖默认 540 秒 block wait。
- 当前仓库在 `CODEX_CLAUDE_ALLOW_ROOTS` 中。
- Claude CLI 可用；如果 doctor 报告 auth unknown，请先手动确认 Claude Code 能运行一次简单任务。

One Message To Codex：

```text
请先调用 claude_setup 检查当前仓库。
如果 ready，请用 claude_task 的 read 模式总结这个仓库的结构、测试命令和适合委托给 Claude 的任务类型。
```

### 60 秒演示（节省 Token 的等待模式）

`claude_task` 默认在 MCP 服务器内部等待 Claude 完成最长 540 秒。完成时直接返回标准化结果，无需额外的轮询：

```text
1. claude_setup                          → 检查工作区就绪状态
2. claude_task(mode="read", ...)         → 委托读取任务，等待并返回结果
3. claude_task(mode="write", ...)        → 委托写入任务，等待并返回结果
4. Result includes worktree path
5. claude_apply(preview=true, ...)       → 预览 diff，返回 preview_token
6. user approval                         → 用户确认
7. claude_apply(cleanup=true, preview_token=..., ...) → 应用变更并清理 worktree
8. claude_cleanup(dry_run=true, ...)     → 确认没有残留 worktree
```

如果任务在等待窗口内未完成（如大型重构），`claude_task` 返回 `status="running"` 和 `job_id`。使用 `claude_task(job_id=...)` 继续等待同一任务。

## 功能特性

- **委托读取/审查/写入任务** — 从 Codex 到 Claude Code
- **隔离的 git worktree 执行** — 写入任务在独立的 worktree 中运行，不影响主工作区
- **节省 Token 的内联等待** — `claude_task` 默认阻塞等待结果，减少模型往返
- **应用前预览** — 在变更落地到主工作区前预览 worktree diff，支持生成二进制 git diff patch
- **审查门禁** — 可选的 stop-hook，在终端状态转换前提示审查
- **敏感文件保护** — `sensitive_file_policy` 控制 `.env`、secrets、SSH 密钥等敏感文件的读取 deny 规则（default/strict/off）
- **跨仓库上下文 (context_roots)** — 为 `claude_task`/`claude_query`/`claude_review` 提供额外的只读仓库根目录。查询模式下收窄 Bash allowlist（移除 `find`/`rg`/`wc`/`ls`/`head`/`tail`/`cat`），并为每个上下文根注入敏感文件 deny 规则。不适用于写入模式。基于上下文根的发现或回答必须使用 `[alias]` 标注来源路径。
- **Server-side verification** — `verification_commands` 让 server 在 delegated worktree 中独立运行受控验证命令
- **产物索引 (Artifact Index)** — `.codex-claude-delegate/artifacts/artifacts.json` 记录 patch 和 verification 产物的元数据（路径/SHA-256/字节数/时间戳/敏感度）。仅存储元数据，高敏感度输出通过文件路径引用，不内嵌内容。`claude_result` 和 `claude_workspace_status` 返回安全的聚合摘要（条目数、类型/敏感度计数、最新时间戳）。

## 安装

### 前置条件

- 已安装并登录 Codex CLI
- `node` >= 20 且在 PATH 中
- Claude Code CLI `claude` 在 PATH 中（或设置 `CLAUDE_BIN` 环境变量）
- Git（写入模式需要 worktree 支持）

### 全局安装（推荐）

```bash
npm install -g @anyi61/codex-claude-delegate-mcp
```

验证安装：

```bash
codex-claude --version
```

### 配置

将 MCP 服务器配置写入 Codex 配置文件：

```bash
codex-claude setup --write
```

这会在 `~/.codex/config.toml` 中添加 `command = "codex-claude"` 及默认的 5 个工具。

选项：

| 参数 | 说明 |
|------|------|
| `--force` | 覆盖已有的 claude_delegate 配置（会创建带时间戳的备份） |
| `--allow-root <path>` | 将仓库添加到全局 Codex 配置 (`~/.codex/config.toml`) 的 `CODEX_CLAUDE_ALLOW_ROOTS` |
| `--project` | 写入 `./.codex/config.toml` 项目级配置，不修改全局 Codex 配置 |
| `--print` | 预览将要写入的配置 |

注意：`--project` 和 `--allow-root` 不可组合使用，它们作用于不同范围的配置。
需要同时配置时，先运行 `setup --write --allow-root <path>` 完成全局 allow-root 配置，
再运行 `setup --write --project` 写入项目级 MCP 配置。

### 诊断

验证安装是否正常：

```bash
codex-claude doctor
```

检查项：Node.js ≥ 20、包版本、Claude CLI 路径/版本/auth 状态、Git、worktree 支持、Codex 配置、MCP command、默认 5 工具、allow roots、`tool_timeout_sec`、MCP launch smoke。失败输出会给出 Problem / Fix / Next step。

```bash
codex-claude doctor --json
```

### 打印配置

查看 MCP 服务器 TOML 配置（不写入文件）：

```bash
codex-claude print-config
codex-claude print-config --source /path/to/repo
codex-claude print-config --project
```

### 清理本地状态产物

预览或清理本工具维护的 terminal background job records、旧 run logs 和过期产物索引条目：

```bash
codex-claude cleanup-artifacts
codex-claude cleanup-artifacts --dry-run --older-than-hours 24 --limit 50
codex-claude cleanup-artifacts --execute
```

`cleanup-artifacts` 默认是 dry-run。只有传入 `--execute` 才会删除已结束的 job records、匹配保留窗口的 run logs，以及过期的产物索引条目及其引用的文件（仅限 `.codex-claude-delegate/artifacts/` 和 `.codex-claude-delegate/apply-backups/` 内的文件）。它不会删除 delegated worktree；worktree 仍使用 `claude_cleanup(cwd="...", dry_run=true)` 预览，再用 `dry_run=false` 清理。

## 默认工具集

`setup --write` 和 `print-config` 启用恰好 5 个工具：

| 工具 | 用途 |
|------|------|
| `claude_setup` | 首次使用 / 检查工作区就绪状态 |
| `claude_task` | **推荐入口**，自动路由到读取/审查/写入，默认内联等待结果 |
| `claude_result` | 获取最近完成的执行结果 + 下一步建议 |
| `claude_apply` | 预览或落地 worktree 变更到主工作区 |
| `claude_cleanup` | 清理过期的委托 worktree（默认 dry-run） |

## 使用流程（节省 Token 的内联等待）

`claude_task` 默认等待 Claude 在 MCP 服务器内部完成（最长 540 秒），直接在响应中返回标准化结果。这意味着 Codex 不需要额外的模型轮询调用。

### 只读分析（快速路径）

```text
claude_task(mode="read", cwd="/path/to/repo", task="解释认证的工作原理")
  → 内联等待完成 → 返回 { status: "success", completed_inline: true, summary: "..." }
  → 检查结果（无 worktree，无需 apply）
```

### 写入 / 应用 / 清理（内联完成路径）

```text
claude_task(mode="write", cwd="/path/to/repo", task="实现特性 X")
  → 内联等待完成 → 返回 { status: "success", completed_inline: true, ... }
  → claude_apply(cwd="...", worktree_path="...", preview=true)
  → user confirms → claude_apply(cwd="...", worktree_path="...", cleanup=true, confirmed_by_user=true, preview_token="<from-preview>")
  → claude_cleanup(cwd="...", dry_run=true)
```

### 长任务恢复路径

如果 Claude 在 540 秒内未完成，`claude_task` 返回 `status="running"` 和 `job_id`：

```text
claude_task(mode="write", ...)
  → 返回 { status: "running", completed_inline: false, job_id: "job-xxx", waiting: true }
  → claude_task(job_id="job-xxx")
  → 继续内联等待，完成后返回标准化结果
  → claude_apply(preview=true, ...)
```

### 失败/部分完成后恢复实现 Session

write 任务默认不会自动复用 Claude session。如果任务返回 partial / failed 状态：

1. Codex 会先建议 `claude_apply preview=true` 预览现有 worktree 改动（如有实际改动）
2. 如果有可恢复的实现 session，Codex 会建议 `claude_task(mode="write", resume_latest=true, task="Continue the previous implementation task and finish incomplete work.")`
3. 用户需要明确选择 preview / resume / discard 之一
4. 系统不会自动 apply、自动 resume 或自动 cleanup

```text
claude_task(mode="write", ...)
  → 返回 { status: "partial"/"failed", session: { session_id: "..." }, ... }
  → next_actions: [claude_apply preview=true (如有改动), claude_task(mode="write", resume_latest=true, task="Continue the previous implementation task and finish incomplete work.")]
  → 用户决定: preview → apply, or resume → 继续任务, or discard → 放弃
```

## 高级 / 调试工具

这些工具**不**在默认配置中。需要手动在 `~/.codex/config.toml` 中启用时，保留默认 5 个工具，再追加需要的高级工具：

```toml
[mcp_servers.claude_delegate]
enabled_tools = [
  "claude_setup",
  "claude_task",
  "claude_result",
  "claude_apply",
  "claude_cleanup",
  "claude_status",
  "claude_runs",
  "claude_run_inspect",
  "claude_workspace_status",
  "claude_review_gate",
  "claude_job_wait",
  "claude_query",
  "claude_review",
  "claude_implement",
  "claude_jobs",
  "claude_job_result",
  "claude_job_cancel",
  "claude_job_cleanup",
  "claude_export",
]
```

| 工具 | 用途 |
|------|------|
| `claude_status` | 检查 Claude/Git/worktree/认证状态 |
| `claude_runs` | 列出历史运行日志 |
| `claude_run_inspect` | 按 run_id 查看单次运行详情 |
| `claude_workspace_status` | 聚合视图：任务 / 运行 / 会话 / worktrees |
| `claude_review_gate` | 启用/禁用/查看审查门禁状态 |
| `claude_query` | 只读问答（底层入口） |
| `claude_review` | 只读审查（底层入口） |
| `claude_implement` | 隔离 worktree 实现（底层入口） |
| `claude_jobs` | 列出后台任务 |
| `claude_job_result` | 按 job_id 读取任务结果 |
| `claude_job_cancel` | 取消正在运行的任务 |
| `claude_job_cleanup` | 清理过期的终端任务记录 |
| `claude_job_wait` | **高级/恢复兼容** — 使用与 `claude_task(job_id=...)` 相同的内联等待机制 |
| `claude_export` | 将 delegated worktree 的变更导出到本地分支，不修改主工作区 |

## 重要说明

- **`mode_inference` 返回字段：** `claude_task` 结果包含可选的 `mode_inference` 对象，记录自动模式推断详情。字段：`requested_mode`（原始请求 mode）、`delegated_mode`（最终 read/review/write）、`reason`（推断原因，如 `write_hints`/`review_hints`/`read_hints`/`query_prefix_override`/`mixed_intent_review_first`/`diff`/`constraints`/`explicit`/`files_fallback`/`default_read`）、`confidence`（`high`/`medium`/`low`）、`matched_hints`（命中的关键词数组，如 `["修复"]`）。支持中文/混合语言关键词自动路由；包含 write 关键词和风险/安全/问题信号的混合意图会保守路由到 review。旧客户端可忽略此字段。
- **安全 profile：** 写入任务默认使用 `security_profile="default"`，不允许 `npx *` 这类远程包执行路径。`strict` 更收窄；只有在明确需要并理解风险时才使用 `permissive`，它会恢复更宽的本地命令 allowlist。
- **敏感文件保护：** `sensitive_file_policy` 控制 Read/Grep/Glob 和 Bash 读取命令（cat/head/tail/grep）对敏感文件的 deny 规则。`default`（默认）阻止根目录或子目录中的 `.env`/`.env.*` 以及 `secrets/**`；`strict` 额外阻止 `**/*.pem`/`**/*.key`/`**/*.p12`/`**/*.pfx`、`**/id_rsa*`/`**/id_ed25519*`/`**/id_ecdsa*`、`.aws`/`.ssh`/`.gnupg`/`.kube`/`.docker`、`.netrc`/`.npmrc`/`.pypirc`、`credentials*`/`credential*`；`off` 移除所有敏感文件 deny 规则，但保留 `rm *`/`sudo *` 等危险 Bash 命令的 deny。此字段适用于 `claude_task`、`claude_query`、`claude_review`、`claude_implement`。
- **Server-side verification：** `verification_commands` 适用于 `claude_task` 写入模式和 `claude_implement`。Claude 完成后，server 会在 delegated worktree 内按顺序运行受控验证命令，并在返回体/run log 中写入 `server_verified`。命令会被解析为 argv 且不经过 shell；只允许测试/类型检查/lint 类命令族，例如 `npm test`、`npm run <script>`、`npx vitest ...`、`npx tsc ...`、`pytest ...`、`go test ...`、`cargo test ...`。验证失败会把原本的 success 降为 partial，但不会自动 apply 或清理 worktree。验证的 stdout/stderr tails 会被写入 `.codex-claude-delegate/artifacts/verification/<runId>/` 并在产物索引中注册为高敏感度条目。
- **Package-manager verification scripts：** `npm test`、`npm run <script>`、`yarn test`、`yarn run <script>`、`pnpm test`、`pnpm run <script>` 执行 delegated worktree 中仓库定义的脚本。产品决策是保持这些 package-manager scripts 可用，以保留 Claude 自主验证能力。风险缓解来自：(1) 环境清洗（`sanitizeEnv()` 防止 secret 泄露），(2) 命令解析为 argv 且不经过 shell（防止 shell 注入），(3) `FORBIDDEN_SCRIPT_NAMES` 阻止高风险脚本名（`install`/`publish`/`deploy`/`start` 等）。
- **instruction_files vs `files`：** 对普通 `claude_task`，计划、清单、规格文档必须放在 `instruction_files`，或直接在 `task` 中提到。`claude_task.files` 已废弃，只作为兼容的上下文文件处理，不是 apply 范围限制。`instruction_files` 仅限主仓库（primary cwd）路径。
- **context_roots：** `claude_task`/`claude_query`/`claude_review` 可通过 `context_roots` 传入最多 5 个额外的只读仓库根目录（`{ alias, cwd }`）。验证规则：alias 唯一且仅含 `[A-Za-z0-9_-]`（最长 32），cwd 必须与 primary cwd 不重叠且不是 delegated worktree 路径。写入模式下传入 `context_roots` 会被拒绝。查询模式下 Bash allowlist 会收窄为 `git diff/log/status/show`（移除 `find`/`rg`/`wc`/`ls`/`head`/`tail`/`cat`），并为每个上下文根按绝对路径注入敏感文件 deny 规则。基于上下文根文件或命令输出的发现、回答必须使用 `[alias]` 加文件路径或 git 命令标注来源；仅基于主仓库的内容不需要上下文根引用。
- **`allowed_files`：** 在 `claude_task` 写入模式中，`allowed_files` 定义硬文件范围——只有列表中的文件可以被修改。超出范围的文件变更会被 scope checker 拒绝。读取/审查模式下 `allowed_files` 会被静默忽略。`allowed_files` 和 `max_changed_files` 会透传到底层 `claude_implement`。
- **`claude_implement.files`** 是严格的范围控制，用于需要精确文件约束的场景。`claude_task.allowed_files` 和 `claude_implement.files` 语义相同。
- **未提交的工作区变更：** 默认返回 `needs_user`。传入 `dirty_policy=committed` 忽略本地变更，或 `dirty_policy=snapshot` 将脏文件复制到 worktree。
- **内联等待：** `claude_task` 默认在 MCP 服务器内部等待任务结果长达 `wait_timeout_sec` 秒（默认 540，最大 540）。如果任务在该窗口中完成，直接返回标准化结果（`completed_inline=true`）。`wait_timeout_sec` 仅控制 inline wait 窗口，不是任务总执行超时；任务可能在后台继续运行直到内部 3600 秒上限。
- **长任务恢复：** 如果任务超过 `wait_timeout_sec` 仍未完成，使用 `claude_task(job_id=...)` 继续等待。不要重新委托同一任务。
- **后台模式：** 使用 `wait_strategy="background"` 或 `background=true` 让 `claude_task` 立即返回，稍后用 `claude_task(job_id=...)` 获取结果。
- **内部执行超时：** Claude CLI 的内部执行超时固定为 3600 秒（1 小时），独立于 `wait_timeout_sec`。这确保长任务可以在多个等待周期后完成。
- **回合上限与预算控制：** `claude_task` 不接受 `timeout_sec`、`max_turns` 或 `max_cost_usd`。需要显式回合限制或硬预算控制时，使用高级工具（`claude_query` / `claude_review` / `claude_implement`）。
- **应用安全：** `preview=true` 不会修改主工作区，并返回 `preview_token`（64 位十六进制）。非预览模式的 `claude_apply` 需要用户确认后设置 `confirmed_by_user=true`，且必须传入匹配的 `preview_token`。token 包含了 worktree 内容哈希和主工作区目标文件状态的确定性摘要——如果 worktree 内容或主工作区目标文件在预览和 apply 之间被修改，token 不匹配会导致 apply 被拒绝，防止 TOCTOU 攻击。主工作区碰撞检测（脏文件、未跟踪文件、gitignored 文件、目录/文件冲突、父路径为文件、大小写兄弟冲突）在 preview 阶段即拒绝 unsafe 状态。
- **无效组合：** `preview=true` + `cleanup=true` 会被拒绝——预览不应删除 worktree。
- **下一步操作：** `claude_result` 和已完成的内联等待仅建议预览操作（`preview=true`），绝不直接建议非预览应用。
- **Diff patch 预览：** 使用 `include_patch=true` 生成包含 `diff --git` 内容的二进制 git diff patch。patch 覆盖 tracked 的已提交和未提交变更。patch 过大时（超出 `patch_max_bytes`，默认 60000，范围 1024–500000），完整 patch 写入 `.claude/patches/<runId>.patch`，结果中返回 `patch_truncated=true`、`patch_path` 和 `diff_sha256`（完整 patch 的 SHA-256）。注意：git diff 不包括未跟踪文件，此时 `untracked_not_in_patch=true` 会在 planned_changes 包含未跟踪文件时设置。
- **审查门禁绑定：** 启用 `claude_review_gate` 后，写入或 apply 会记录待审查的 run。只有显式带上匹配的 `reviewed_run_id`（需要更严格时同时带 `reviewed_worktree_path`）的成功 review 才会清除 pending；普通无绑定 review 不会清除门禁。

## 配置

### 允许根目录（Allow roots）

默认允许的根目录为 `~/projects`、`~/work`、`~/codex-claude`。`CODEX_CLAUDE_ALLOW_ROOTS` 环境变量存在时会覆盖默认白名单；该变量就是完整允许列表，默认目录不会隐式保留。

如需保留默认目录，必须将它们显式列在环境变量中。新增目录时，建议使用 `codex-claude setup --write --allow-root <path>` 写入配置，或手动将完整列表写入环境变量。

```toml
# ~/.codex/config.toml
[shell_environment_policy.set]
CODEX_CLAUDE_ALLOW_ROOTS = "/Users/you/projects:/Users/you/work:/Users/you/my-repo"
```

或使用 CLI：

```bash
codex-claude setup --write --allow-root "$(pwd)"
```

### 环境变量透传（Env Passthrough）

`sanitizeEnv()` 使用严格白名单，仅转发以下 16 个默认变量：

```
PATH, HOME, SHELL, LANG, LC_ALL, LC_CTYPE, TERM, USER,
TMPDIR, TEMP, TMP, NODE_ENV, HTTP_PROXY, HTTPS_PROXY, NO_PROXY, ANTHROPIC_BASE_URL
```

如需额外透传自定义环境变量，设置 `CODEX_CLAUDE_ENV_PASSTHROUGH`（逗号分隔，大小写敏感）：

```toml
# ~/.codex/config.toml
[shell_environment_policy.set]
CODEX_CLAUDE_ENV_PASSTHROUGH = "MY_ORG_API_URL,CI_PIPELINE_ID"
```

**安全限制：**
- 名称匹配 `[A-Za-z_][A-Za-z0-9_]*`，无效字符自动忽略
- 精确敏感名称（`DATABASE_URL`、`DSN` 及所有已知密钥）被拦截
- 名称包含 `AUTH`、`COOKIE`、`SESSION`、`PRIVATE`、`KEY`、`SECRET`、`TOKEN`、`CREDENTIAL`、`PASSWORD`、`API_KEY` 的变量被拦截
- `CODEX_CLAUDE_ENV_PASSTHROUGH` 本身从不转发
- 重复名称自动去重

`codex-claude doctor` 报告环境净化诊断（allowlisted/passthrough/blocked 计数和名称，不暴露任何变量值）。

### 本地环境配置诊断

可在仓库内放置 `.codex-claude-delegate/environment.json`，用于记录本仓库的环境准备意图：

```json
{
  "install": "npm ci",
  "test": "npm run typecheck",
  "start": "npm run dev",
  "symlink_directories": ["/absolute/cache/path"],
  "sparse_paths": ["src", "tests"],

  "verification": {
    "allowedScripts": ["typecheck", "lint", "test:unit"],
    "timeoutSec": 180
  },
  "artifacts": {
    "retentionDays": 30
  },
  "environment": {
    "passthrough": ["MY_CUSTOM_VAR", "NODE_OPTIONS"]
  }
}
```

#### Phase 1 字段（基础）

| 字段 | 类型 | 说明 |
|------|------|------|
| `install` | string | 安装命令（诊断回显，不自动执行） |
| `test` | string | 测试命令（诊断回显，不自动执行） |
| `start` | string | 启动命令（诊断回显，不自动执行） |
| `symlink_directories` | string[] | 符号链接目录（诊断回显，不自动创建） |
| `sparse_paths` | string[] | 稀疏检出路径（诊断回显，不自动设置） |

#### Phase 2 字段（环境/验证/产物配置） — 非提权，仅约束或诊断

| 字段 | 类型 | 约束 | 执行效果 |
|------|------|------|----------|
| `verification.allowedScripts` | string[] | 最多 50 项，每项 ≤100 字符，匹配 `[A-Za-z0-9][A-Za-z0-9:_-]*`，禁止 `install`/`deploy`/`publish`/`start`/`serve`/`add`/`remove`/`uninstall`，禁止 shell 元字符，重复自动去重 | **限制性**：仅约束 `npm run <script>` / `yarn run <script>` / `pnpm run <script>` 的脚本名，不扩展命令范围。非 run-script 命令不受影响 |
| `verification.timeoutSec` | integer | 10–300 | **限制性**：约束验证超时上限，默认 120s |
| `artifacts.retentionDays` | integer | 1–365 | **仅诊断**：在 doctor 和 workspace_status 中展示，不影响实际清理行为 |
| `environment.passthrough` | string[] | 最多 100 项，每项 ≤256 字符，匹配 `[A-Za-z_][A-Za-z0-9_]*`，敏感名称（含 KEY/SECRET/TOKEN 等）被拒绝，重复自动去重 | **仅诊断**：在 doctor 和 workspace_status 中展示，不改变 env forwarding 行为 |

#### 向后兼容

- 当 `.codex-claude-delegate/environment.json` 不存在或仅包含 Phase 1 字段时，行为与之前版本完全一致。
- Phase 2 字段均为可选，未知顶层字段和未知子字段产生警告而非错误（保持向前兼容）。
- 配置校验失败时，Phase 2 执行设置不回退：`verification.allowedScripts` 和 `verification.timeoutSec` 仅在配置整体有效时生效。
- 摘要（summary）绝不暴露 `install`/`test`/`start` 的命令字符串值或任何 secret 值，但可暴露允许的脚本名称和安全的 passthrough 变量名。

当前版本只读取并校验该文件，并在 `codex-claude doctor` 与 `claude_workspace_status` 中显示安全摘要。不会执行 `install`、`test` 或 `start`，也不会创建 symlink 或 sparse checkout。

### 开发 / 维护

从源码构建：

```bash
git clone https://github.com/anyi61/codex-claude.git
cd codex-claude
npm install
npm run build:plugin
npm run check:plugin
```

插件目录（`plugins/`）用于内部打包。开发时使用 `npm run dev` 或 `npm run build`。

### 安全扫描

```bash
npm run security:grep
```

扫描 `src/` 中的安全敏感模式，包括 `spawn()`、`shell: true`、`process.env` 直接访问和边界敏感文件中的 `path.join()`。Phase 1 使用已知安全位置白名单，不新增 lint 依赖；新增命中会以非零退出提示审查。

## 故障排查

| 问题 | 解决方法 |
|------|---------|
| `claude` 命令未找到 | 安装 Claude Code CLI 或设置 `CLAUDE_BIN` 环境变量 |
| cwd 不在 allow roots 中 | `codex-claude setup --write --allow-root "$(pwd)"` |
| 危险的 allow root | 使用具体的仓库路径，不要用 `/`、`/tmp`、`/etc` 或 `$HOME` |
| `waiting=true` / `completed_inline=false` | 使用 `claude_task(job_id=...)` 继续等待同一任务 |
| `claude_job_wait` 不在默认工具中 | `claude_job_wait` 已改为高级/恢复兼容工具。默认路径使用 `claude_task(job_id=...)` 继续等待 |
| 任务过期 | 使用 claude_result 检查；高级工具中可使用 claude_job_cancel |
| 应用被拒：主工作区冲突 | 查看 conflicts 字段了解具体冲突类型（未提交变更、未跟踪文件、gitignored 文件、目录/文件冲突等），修复后重试 |
| 缺少 `confirmed_by_user` | 展示预览并获得用户明确批准后再应用 |
| 缺少 `preview_token` | 先调用 `claude_apply(preview=true)` 获取 token，确认 planned_changes 安全后，传入 token 再次 apply |
| `preview_token` 不匹配 | worktree 内容或主工作区目标文件状态在预览和 apply 之间发生了变化。重新调用 `claude_apply(preview=true)` 获取新 token |
| `preview=true` + `cleanup=true` | 拆分为预览和已确认的应用+清理两步 |
| 残留 worktree | `claude_cleanup(cwd="...", dry_run=true)` 然后 `dry_run=false` |
| apply 被拒：symlink 写入 | symlink 写入、模式(chmod)变更和文件/目录类型互换不受支持。apply 会拒绝这些变更并报告具体冲突 |
| 旧 job/run log 状态产物 | `codex-claude cleanup-artifacts` 预览后再加 `--execute` |

## 卸载

```bash
codex-claude uninstall --yes
npm uninstall -g @anyi61/codex-claude-delegate-mcp
```

`codex-claude uninstall` 会先清理 Codex 中的 `claude_delegate` MCP server 配置和本工具维护的 allow-root 配置，并报告 workspace state 与 delegated worktree 残留。它不会自动删除 delegated worktree；如需删除，先在卸载前用 `claude_cleanup(cwd="...", dry_run=true)` 预览，再用 `dry_run=false` 清理。

必须先运行 `codex-claude uninstall`，再运行 `npm uninstall -g`。如果先卸载 npm 包，`codex-claude` 命令会消失，只能手动编辑 `~/.codex/config.toml` 删除 `[mcp_servers.claude_delegate]`。

## 安全

- `spawn("claude", args[])` — 无 shell 注入
- `--tools` / `--allowedTools` / `--disallowedTools` — 三层工具控制
- `--permission-mode dontAsk` — 非交互式安全模式
- `sanitizeEnv()` — 严格环境白名单：仅转发 16 个默认安全变量和 `CODEX_CLAUDE_ENV_PASSTHROUGH` 中声明的额外变量；敏感名称（AUTH/COOKIE/SESSION/PRIVATE/KEY/SECRET/TOKEN/CREDENTIAL/PASSWORD/API_KEY/DATABASE_URL/DSN）在 passthrough 中也被拦截；`CODEX_CLAUDE_ENV_PASSTHROUGH` 本身从不转发
- `BRIDGE_DEPTH` — 递归保护（≥2 时拒绝）
- `validateCwd()` — realpath + allow roots 白名单
- `dangerousRoot()` — 拒绝 15 个系统目录（`/`, `/bin`, `/boot`, `/dev`, `/etc`, `/lib`, `/lib64`, `/opt`, `/proc`, `/root`, `/sbin`, `/sys`, `/tmp`, `/usr`, `/var`）及其子目录；`$HOME` 本身拒绝，但子目录如 `~/projects` 安全
- `CODEX_CLAUDE_ALLOW_ROOTS` 可覆盖危险目录的子目录限制（如 macOS 下 `/var/folders/.../repo`），但不能放行危险根目录本身

## 已知限制

- 不支持实时双向通信（Codex → Claude 单向委托）
- 每次调用 Claude 约 2-5 秒冷启动
- 无自动 worktree 清理（使用 `claude_cleanup`）
- 老旧的任务记录缺少指纹/心跳；过期分类回退到 updated_at
- 过期检测仅为参考，不会自动终止进程

## 维护者发布清单

```bash
# 确保 git 已提交所有更改
git status

# 一行发布: 自动 bump patch 版本 → 同步 plugin metadata 版本 → build/test/release checks → publish
npm run release
```

发布脚本会在 `npm version` 后运行 `npm run sync:plugin-version`，确保以下版本一致:

- `package.json`
- `package-lock.json`
- `plugins/codex-claude-delegate/.codex-plugin/plugin.json`
- `plugins/codex-claude-delegate/.claude-plugin/plugin.json`

发布后确认 npm registry 与本地版本一致:

```bash
npm view @anyi61/codex-claude-delegate-mcp version dist-tags.latest
node -p "require('./package.json').version"
```

也可使用元数据检查脚本自动验证 registry/tag 一致性:

```bash
npm run check:release:metadata
```

然后提交 release bump 并创建 tag:

```bash
git add package.json package-lock.json plugins/codex-claude-delegate/.codex-plugin/plugin.json plugins/codex-claude-delegate/.claude-plugin/plugin.json
git commit -m "chore: release v$(node -p "require('./package.json').version")"
git tag v$(node -p "require('./package.json').version")
git push origin main --tags
```
