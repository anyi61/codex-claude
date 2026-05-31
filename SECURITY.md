# SECURITY — codex-claude-delegate-mcp

codex-claude-delegate-mcp 是一个本地 MCP 服务器，将 Codex CLI 的读取、审查、写入任务委托给 Claude Code 执行。**它不是强沙箱**；安全模型依赖多层纵深防御，每一层独立限制 Claude 的破坏半径。

> **威胁模型**：Claude Code 是由 LLM 驱动的编程代理，运行在你的本机文件系统上。MCP 协议将工具暴露给模型调用，模型可能被 prompt-injected、被指令诱导，或在失控反应中执行危险操作。本项目的安全设计假设 Claude 进程本身不可信，并在每个边界施加约束。

## OWASP LLM 风险对齐

本项目针对 OWASP Top 10 for LLM Applications 中的以下风险实施对策：

| OWASP 风险 | 本项目的对策 |
|-----------|-------------|
| **LLM01: Prompt Injection** | 目录隔离、命令白名单、输入 Zod strict 校验、禁止 `curl`/`wget` |
| **LLM02: Insecure Output Handling** | `safeErrorMessage` 路径脱敏、结构化输出 Zod schema 校验 |
| **LLM03: Training Data Poisoning** | 不适用（本地工具，不涉及训练数据） |
| **LLM04: Model Denial of Service** | 高级工具 hard budget（`max_turns` ≤ 50、`max_cost_usd` ≤ 10）、`claude_task` inline wait、内部超时 3600s |
| **LLM05: Supply Chain Vulnerabilities** | CLI 二进制路径可配置 `CLAUDE_BIN`、依赖 lockfile、插件 bundle 不可变 |
| **LLM06: Sensitive Information Disclosure** | 严格环境白名单 + passthrough 拦截 + `safeErrorMessage` 路径脱敏 + stderr `redactSensitive` |
| **LLM07: Insecure Plugin Design** | MCP tool annotations（`readOnlyHint`/`destructiveHint`）、工作区隔离、review gate |
| **LLM08: Excessive Agency** | 三层安全 profile、命令白名单、git worktree 隔离写入 |
| **LLM09: Overreliance** | `confirmed_by_user` 强制、preview-before-apply 流程 |
| **LLM10: Model Theft** | 不适用（本地部署，无外部模型访问） |

## MCP 工具安全模型

### 工具注解 (Tool Annotations)

每个 MCP 工具注册时都带有注解，让 MCP 客户端（Codex）自主决定是否在调用前提示用户确认：

| 工具 | readOnlyHint | destructiveHint | openWorldHint |
|------|:---:|:---:|:---:|
| `claude_status` | ✓ | | ✓ |
| `claude_setup` | | ✓ | ✓ |
| `claude_runs` | ✓ | | ✓ |
| `claude_run_inspect` | ✓ | | ✓ |
| `claude_result` | ✓ | | |
| `claude_workspace_status` | ✓ | | ✓ |
| `claude_task` | | ✓ | ✓ |
| `claude_review_gate` | | | ✓ |
| `claude_query` | | | ✓ |
| `claude_review` | | | ✓ |
| `claude_implement` | | | ✓ |
| `claude_jobs` | ✓ | | ✓ |
| `claude_job_result` | ✓ | | ✓ |
| `claude_job_cancel` | | ✓ | ✓ |
| `claude_job_wait` | ✓ | | ✓ |
| `claude_apply` | | ✓ | |
| `claude_cleanup` | | ✓ | |

`destructiveHint: true` 的工具会修改状态或写入文件。`openWorldHint: false` 的工具（`claude_result`、`claude_apply`、`claude_cleanup`）不启动 Claude 外部推理进程——但 `claude_apply` 仍会写入主工作区文件，`claude_cleanup` 仍会移除 worktree 目录。

默认启用的 5 个工具中，只有 `claude_setup`、`claude_task`、`claude_apply`、`claude_cleanup` 标记为 destructive。`claude_result` 标记为 readOnly。

## 安全层详解

### 第 1 层：目录访问控制 — 哪些目录永远拒绝

`src/guard.ts` 实现三层目录检查，每次工具调用都会执行。

#### 精确危险根目录（不可覆盖）

15 个系统目录**精确匹配时永远拒绝**，即使 `CODEX_CLAUDE_ALLOW_ROOTS` 包含它们也无法绕过：

```
/, /bin, /boot, /dev, /etc, /lib, /lib64, /opt,
/proc, /root, /sbin, /sys, /tmp, /usr, /var
```

`$HOME` 本身也被视为精确危险根目录——工具不能直接在 `$HOME` 下运行。

#### 前缀危险根目录（可被 allow-roots 覆盖）

上述危险根目录的**子目录**也被拒绝（如 `/var/log`、`/usr/local/bin`），但有一个例外：**允许根目录可以覆盖前缀匹配**。这是为了支持 macOS 上 `/var/folders/...` 这类正常仓库路径。

#### 允许根目录白名单

默认允许：`~/projects`、`~/work`、`~/codex-claude`。`CODEX_CLAUDE_ALLOW_ROOTS` 环境变量存在时会覆盖默认白名单；该变量就是完整允许列表，不会与默认目录合并。新增目录建议通过 `codex-claude setup --write --allow-root <path>` 写入配置。

`validateCwd()` 在每次工具调用时验证 cwd：
1. 解析符号链接 (`realpath`)
2. 检查精确危险根目录 → 直接拒绝，不可绕过
3. 检查前缀危险根目录 → 拒绝（除非在 allow-roots 中）
4. 检查是否在 allow-roots 中 → 不在则拒绝
5. 检查是否为目录 → 不是则拒绝

#### 文件逃逸防护

`validateFilesWithinCwd()` 对每个传入的文件路径做 `realpath` 后验证其前缀严格等于 cwd，防止 `../../../etc/passwd` 这类路径遍历攻击。

### 第 2 层：命令白名单 — Claude 能跑什么命令

Claude Code 运行时的工具集由 `--allowedTools` 和 `--disallowedTools` 双面约束。

#### 全局禁止命令（所有模式）

```
rm *, rm -rf *, rm -r *, sudo *, curl *, wget *,
chmod *, chown *, git push *, ssh *, scp *, nc *, netcat *
```

#### 敏感文件 Deny 规则

`sensitive_file_policy`（可选，默认 `"default"`）控制对敏感文件的读取 deny 规则，适用于所有模式（query/review/implement）。通过 `--disallowedTools` 注入 Claude Code CLI，基于官方 deny 语法：

- `Read(./.env)` — 阻止 Read 工具访问 `.env`
- `Read(./secrets/**)` — 阻止 Read 工具访问 secrets 目录下所有文件
- `Bash(cat ./.env)` — 阻止 `cat ./.env` 命令
- `Grep(./.env.*)` — 阻止 Grep 工具搜索 `.env.*` 文件

**default（默认）** 阻止根目录或子目录中的 `.env`、`.env.*`，以及 `secrets/**` 的 Read/Grep/Glob 和 Bash 读取命令（cat/head/tail/grep）：

```
Read(./.env), Read(./.env.*), Read(./**/.env), Read(./**/.env.*), Read(./secrets/**)
Grep(./.env), Grep(./.env.*), Grep(./**/.env), Grep(./**/.env.*), Grep(./secrets/**)
Glob(./.env), Glob(./.env.*), Glob(./**/.env), Glob(./**/.env.*), Glob(./secrets/**)
Bash(cat/head/tail ./.env), Bash(cat/head/tail ./**/.env), Bash(grep * ./.env), Bash(grep * ./**/.env)
```

**strict** 在 default 基础上额外阻止更广泛的秘密存储：

```
Read(./**/*.pem), Read(./**/*.key), Read(./**/*.p12), Read(./**/*.pfx),
Read(./**/id_rsa*), Read(./**/id_ed25519*), Read(./**/id_ecdsa*),
Read(./.aws/**), Read(./**/.aws/**), Read(./.ssh/**), Read(./**/.ssh/**),
Read(./.gnupg/**), Read(./**/.gnupg/**), Read(./.kube/**), Read(./**/.kube/**),
Read(./.docker/**), Read(./**/.docker/**),
Read(./.netrc), Read(./**/.netrc), Read(./.npmrc), Read(./**/.npmrc),
Read(./.pypirc), Read(./**/.pypirc), Read(./credentials*), Read(./**/credentials*), Read(./**/credential*)
```
（以及对应的 Grep/Glob/Bash 读取命令 deny）

**off** 移除所有敏感文件 deny 规则，但 `rm *`/`sudo *` 等全局危险 Bash 命令的 deny 规则不受影响。

#### Server-Side Verification

`verification_commands` 让 server 在 delegated worktree 中独立运行验证命令，结果写入 `server_verified`。这用于补强 Claude 自报的 `commands_run` / `tests`，不是通用 shell 执行器。

**Package-manager script 执行面：** `npm test`、`npm run <script>`、`yarn test`、`yarn run <script>`、`pnpm test`、`pnpm run <script>` 会执行 delegated worktree 中仓库定义的脚本。产品决策是保持这些命令可用，以保留 Claude 自主验证能力。风险缓解措施：(1) 验证子进程通过 `sanitizeEnv()` 生成环境变量（仅转发白名单变量，不继承父进程含 secret 特征的环境变量），(2) 命令解析为 argv 且通过 `spawn()` 执行（不使用 `shell: true`），(3) `FORBIDDEN_SCRIPT_NAMES` 阻止高风险脚本名。

安全边界：

- 只在 implement/write delegated worktree 中运行，不在 main workspace 中运行。
- 命令字符串会解析为 argv，再通过 `spawn(command, args)` 执行；不使用 `shell: true`。
- 验证子进程通过 `sanitizeEnv()` 生成环境变量，仅转发白名单变量，不继承父进程中含 secret 特征的环境变量。
- 每次最多 10 条命令，每条最长 200 字符，每条默认 120 秒超时，stdout/stderr tail 截断到 4000 字符。
- 允许范围限于测试、类型检查、lint 类命令族：`npm test`、`npm run <script>`、`npx vitest/jest/tsc/eslint ...`、`yarn test/run ...`、`pnpm test/run ...`、`pytest ...`、`go test ...`、`cargo test ...`、`tsc ...`、`eslint ...`。
- `install`、`publish`、`deploy`、`start`、`serve`、删除、权限提升、网络拉取、容器/集群操作等命令会被拒绝或跳过。
- 验证失败会让 implement 返回 `partial` 并保留 worktree 供预览/检查；不会自动 apply 或自动 cleanup。
- **环境配置约束（Phase 2）**：`.codex-claude-delegate/environment.json` 中的 `verification.allowedScripts` 对 `npm run <script>` / `yarn run <script>` / `pnpm run <script>` 形式施加**额外限制**（白名单过滤），并在配置后把 `npm test` / `yarn test` / `pnpm test` 按脚本名 `test` 校验；未配置时这些 test shorthand 保持兼容可用。该配置不扩展命令范围。已有的硬编码禁止名称（install、deploy、publish、start 等）始终优先生效，不会因出现在 `allowedScripts` 中而被放行。`npx vitest`、`npx tsc`、`pytest`、`go test`、`cargo test` 等非 package-script 形式不受 `allowedScripts` 影响。
- **超时约束**：`verification.timeoutSec` 可限制验证超时时间，上限 300 秒，默认 120 秒。该值仅在环境配置有效时生效。

#### 只读模式（query / review）允许的命令

仅允许 `Read`、`Glob`、`Grep` 和只读 Bash 命令：

```
git diff, git log, git status, git show, git blame (仅 review),
find, rg, wc, ls, head, tail, cat
```

#### context_roots 安全约束

`context_roots` 为读取/审查模式提供额外的只读仓库根目录，安全约束如下：

- **仅限读取/审查模式**：写入模式（write/inferred-write）传入 `context_roots` 会被 server 和 `runClaudeTask` 双重拒绝。
- **路径隔离**：每个 context root 的 cwd 必须与 primary cwd 不重叠（非 exact、非 child、非 parent），且不能是 delegated worktree 路径。使用 realpath 规范化后检查。
- **alias 约束**：`[A-Za-z0-9_-]`，1-32 字符，不允许为 `"primary"`，不允许重复。
- **查询模式 Bash allowlist 收窄**：带 `context_roots` 的查询移除 `find`/`rg`/`wc`/`ls`/`head`/`tail`/`cat`，仅保留 `git diff/log/status/show`。
- **上下文根敏感文件 deny**：为每个 context root 按绝对路径注入 `sensitive_file_policy` 对应的 deny 规则（Read/Grep/Glob/Bash 读取命令）。
- **instruction_files 仅限主仓库**：`instruction_files` 路径仅在 primary cwd 内解析。

#### 写入模式（implement）安全 Profile

三个 profile 控制允许的工具集：

**strict（最严格）**：仅安全命令 + 测试命令 + git 操作。无 Node/Python 运行时执行。
```
Read, Glob, Grep, Edit, Write,
git status/diff/add/log/show,
npm test, pytest, go test, cargo test,
ls, cat, wc, find, head, tail, sort, uniq, grep, rg, which, echo, date
```

**default（默认）**：strict + 基本的文件/运行时操作。**无 `npx`**。
```
strict + mkdir, mkdir -p, cp, mv, node, python, python3, tsc, eslint
```

**permissive（仅在明确需要并理解风险时使用）**：default + `npx *`。
```
default + Bash(npx *)
```

#### 写入模式的扩展禁止

在 DANGEROUS_DISALLOWED_TOOLS 之上，implement 模式额外禁止：
```
git push --force, git branch -D, git reset --hard, git clean,
shutdown, reboot, docker, kubectl, brew,
npm install/uninstall/publish, pip install/uninstall,
yarn add/remove, pnpm add/remove
```

### 第 3 层：人工确认 — 哪些操作一定要用户确认

#### `claude_apply` 强制确认

非预览模式 (`preview=false`) 的 apply 操作**强制要求** `confirmed_by_user=true`。如果这个参数未设为 true，apply 会被拒绝并返回明确的错误消息。

这是硬约束，**无法通过任何配置或环境变量绕过**。

#### 自动拒绝 apply 的场景

以下情况下 apply 被自动拒绝，即使在交互中：
- 主工作区有未提交的变更
- Worktree 中包含超出请求文件范围的变更
- Worktree 超过了 implement 资源限制（回合/预算）
- 未找到 worktree 的 implement 元数据
- 工作区状态码异常

#### Transactional apply 路径边界

`claude_apply` 的实际写入由 `applyChangesTransactional()` 执行。写入前的 Phase 0 会先完成以下校验，失败时不创建 backup 目录，也不修改主工作区：

- `file` 必须同时位于 `cwd` 和 delegated `worktreeRoot` 的词法边界内；`old_file` 必须位于 `cwd` 的词法边界内。
- 对 `A` / `M` / `R` / `C`，source 会先经过 `lstat()`，拒绝符号链接和非普通文件，再通过 `realpath()` 确认真实路径仍在 `worktreeRoot` 内。
- 对写入目标，现有父目录会通过 `realpath()` 确认仍在 `cwd` 内，避免 `cwd` 内的 symlink 目录把写入导出仓库。
- 对删除目标和 rename 的 `old_file`，现有路径或现有父目录会通过 `realpath()` 确认仍在 `cwd` 内。
- 不支持的 git status，以及 `R` / `C` 缺少 `old_file`，会在 Phase 0 拒绝。

残余风险：

- Phase 0 校验与 Phase 2 写入/删除之间仍存在本地并发修改窗口。攻击者若能在同一主机上同时改动 `cwd` 或 delegated worktree 的路径条目，仍可能触发竞态；当前缓解依赖 preview token、主工作区状态校验和 Phase 0 的 fail-closed 行为。
- hard link 与普通文件共享 inode，`realpath()` 不会显示外部原始路径。当前策略按普通文件处理 hard link；需要更严格隔离的环境应把 hard link 作为部署/仓库策略禁用项。

#### 脏工作区策略

默认 `dirty_policy="ask"`：当主工作区有未提交变更时，implement 请求返回 `needs_user` 状态，要求用户在 commit/stash/snapshot 之间选择。

#### 预览优先

`claude_result` 和 `claude_task` 的 `next_actions` 默认只建议 `preview=true` 操作，**从不直接建议非预览 apply**。

#### 无效组合拒绝

`preview=true` + `cleanup=true` 被 Zod schema 层直接拒绝——预览不应删除 worktree。

### 第 4 层：进程隔离 — Claude 在什么环境里运行

#### Git Worktree 隔离

写入任务在独立的 `git worktree add --detach ... HEAD` 中执行：
- 主工作区**从不被直接修改**
- Worktree 路径在 `.claude/worktrees/` 下，必须以 `codex-delegated-` 为前缀
- `validateFilesWithinCwd()` 防止 worktree 操作逃逸

#### 环境变量清理

`sanitizeEnv()` 对子进程环境实施**严格白名单**（默认仅转发 16 个变量）：

1. **默认白名单（16 个变量）**：`PATH`、`HOME`、`SHELL`、`LANG`、`LC_ALL`、`LC_CTYPE`、`TERM`、`USER`、`TMPDIR`、`TEMP`、`TMP`、`NODE_ENV`、`HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`、`ANTHROPIC_BASE_URL`
2. **显式删除**：`OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GITHUB_TOKEN`、`GH_TOKEN`、`AWS_*`、`CLOUDFLARE_API_TOKEN`、`DOCKER_PASSWORD`、`NPM_TOKEN`、`SSH_AUTH_SOCK`、`SSH_AGENT_PID`（即使加入白名单也会被删除）
3. **可选透传**：通过 `CODEX_CLAUDE_ENV_PASSTHROUGH`（逗号分隔，大小写敏感）声明额外变量名。名称必须匹配 `[A-Za-z_][A-Za-z0-9_]*`，重复自动去重
4. **Passthrough 安全拦截**：以下名称即使在 passthrough 中声明也会被拦截：
   - 精确匹配：`DATABASE_URL`、`DSN`、所有已知密钥名称
   - 包含关键词：`AUTH`、`COOKIE`、`SESSION`、`PRIVATE`、`KEY`、`SECRET`、`TOKEN`、`CREDENTIAL`、`PASSWORD`、`API_KEY`
5. **不在白名单且未在 passthrough 中声明的变量一律丢弃**
6. **`CODEX_CLAUDE_ENV_PASSTHROUGH` 本身从不转发到子进程**
7. **递归深度**：注入 `BRIDGE_DEPTH` 防止递归委托
8. **环境配置 passthrough 仅诊断**：`.codex-claude-delegate/environment.json` 中的 `environment.passthrough` 字段在本轮仅为诊断/状态展示用途，不会影响实际的 env forwarding 行为。实际的 env forwarding 仍由 `CODEX_CLAUDE_ENV_PASSTHROUGH` 环境变量控制。

`codex-claude doctor` 报告环境净化诊断（分类计数和名称），但从不暴露变量值。被拦截的 passthrough 条目不会导致 doctor 状态变为 `not_ready`。

#### 进程生成方式

所有子进程通过 `child_process.spawn()` 直接调用，**不使用 shell**，因此无法通过 shell 注入执行任意命令。

`claude` 二进制通过 PATH 查找（或通过 `CLAUDE_BIN` 指定），参数以数组形式传入，不经过 shell 解析。

#### 内部递归防护

`BRIDGE_DEPTH` 环境变量跟踪递归深度，`MAX_BRIDGE_DEPTH = 2`。当深度 ≥ 2 时，`assertCanDelegate()` 抛出异常，`assertCanStartServer()` 调用 `process.exit(1)`，防止 `claude → delegate → claude → delegate → ...` 无限递归。

### 第 5 层：输出脱敏 — 日志里如何保护敏感信息

#### 产物索引 (Artifact Index)

`.codex-claude-delegate/artifacts/artifacts.json` 是一个机器可读的产物元数据索引，记录由 `claude_apply`（patch）和 server-side verification 产生的文件。**该索引仅存储元数据**（文件路径、SHA-256、字节数、时间戳、生产者、敏感度等级）——绝不嵌入 patch 内容或验证 stdout/stderr 内容。

- **敏感度等级：** `safe`（patch）、`high`（verification stdout/stderr tails）。高敏感度文件的内容通过路径引用，从不内嵌在索引中。
- **安全摘要：** `claude_result` 和 `claude_workspace_status` 仅暴露聚合计数（条目数、按类型/敏感度分类计数、最新时间戳），不暴露逐条路径或哈希值。
- **清理范围：** 产物索引的 prune 逻辑仅在 `.codex-claude-delegate/artifacts/` 和 `.codex-claude-delegate/apply-backups/` 内删除文件，绝不删除这些目录之外的文件。
- **容错：** 索引读写、文件哈希、文件状态等失败不会导致父工作流崩溃——改为跳过索引条目或返回警告。

#### 错误消息路径脱敏

`safeErrorMessage()` (`src/schema.ts:911`) 从返回给 MCP 客户端的错误消息中移除绝对文件系统路径：

- `"/Users/foo/project/src/file.ts"` → `"[path]"`
- `/home/user/.ssh/id_rsa` → `[path]`

原始（未脱敏）错误被写入 stderr 用于调试。

#### 结构化错误递归脱敏

`safeErrorPayload()` (`src/schema.ts:928`) 递归处理错误 payload 对象中的所有值：
- **字符串** → `safeErrorMessage`
- **数组** → 每个元素递归清洗
- **嵌套对象** → 递归 `safeErrorPayload`
- **其他类型**（数字、布尔、null）→ 直接透传

#### Stderr 密文脱敏

`redactSensitive()` (`src/claude-process.ts:23`) 在 Claude CLI 的 stderr 输出写入日志前脱敏：

- `ANTHROPIC_AUTH_TOKEN=...` → `ANTHROPIC_AUTH_TOKEN=***`
- `ANTHROPIC_API_KEY=...` → `ANTHROPIC_API_KEY=***`
- `Authorization: Bearer ...` → `Authorization: Bearer ***`
- `sk-ant-...` / `sk-...` 前缀 → `sk-ant-***` / `sk-***`

环境诊断中的敏感变量值显示为 `"set-redacted"` 而非实际值。

#### 存储安全

- Run log 和 session 文件以纯 JSON 存储在磁盘上，无加密
- Session store 按 `repo_key`（cwd 的 SHA-256 哈希）限定作用域，防止跨仓库 session 泄露
- Session `MAX_AGE_HOURS = 24`，过期后自动裁剪
- Session 和 Job 文件通过原子 `writeFile` + `rename` 模式写入，防止部分读取

### 第 6 层：并发与锁安全

#### 文件锁（TOCTOU 安全）

`src/lock.ts` 实现基于目录的文件锁：
- 旧锁检测：检查 PID 是否存活 + 锁龄 > 10 分钟（`DEFAULT_STALE_MS`）
- 旧锁回收：使用**原子 `rename`** 回收旧锁目录，而非 `rm` + 重试（消除 TOCTOU 竞态）
- 回收后再次确认旧锁未变，防止双人同时回收
- 等待超时默认 5000ms，10ms 轮询间隔

#### Session 写入序列化

`SessionStore.#writeLock` 使用 promise 链模式序列化所有写入操作（`upsert`、`markExpired`、`prune`、`init`），防止并发 read-modify-write 导致数据丢失。

#### Job 锁

`JobStore.update()` 使用 `withFileLock` 保护每次更新操作。

### 第 7 层：输入验证

每个工具输入通过 Zod `.strict()` schema 校验，拒绝未知属性：

**高级工具 hard budget（`claude_query` / `claude_review` / `claude_implement`）：**

| 约束 | 上限 | 说明 |
|------|------|------|
| `max_turns` | 50 | 回合数上限 |
| `max_cost_usd` | 10 | 费用上限 |
| `timeout_sec` | 600 | 工具调用等待超时 |

**`claude_task` inline wait：**

| 约束 | 上限 | 说明 |
|------|------|------|
| `wait_timeout_sec` | 540 | 仅控制 inline wait 窗口，不是任务总执行超时 |
| `max_changed_files` | 100 | 写入模式变更文件数上限 |

**内部固定执行边界：**

| 约束 | 值 | 说明 |
|------|------|------|
| `max_tokens` | 64k | Claude CLI 输出 token 上限 |
| 内部执行超时 | 3600s | Claude CLI 进程硬超时，独立于 `wait_timeout_sec`，不可配置 |

`claude_task` 是默认入口，不接受 `timeout_sec`、`max_turns` 或 `max_cost_usd`。需要 hard budget 控制时使用高级工具。

`worktreeName` 限制为 `[A-Za-z0-9_-]+`，拒绝路径遍历字符。

无效参数组合在 schema 层被拒绝（如 `preview=true` + `cleanup=true`、`resume_latest` + `session_key` 互斥等）。

### 第 8 层：审查门禁 (Review Gate)

可选的 stop-hook 机制，在终态转换前强制审查：
- `manageClaudeReviewGate(action="enable")` 在 `.codex-claude-delegate/review-gate.json` 写入状态
- 写入或审查活动后将 `pending_review` 标记为 true
- 使用 `resolveRepoLocalPath()` 防止状态文件路径遍历

## Claude CLI 路径安全

### 如果 `claude` 路径被替换会怎样

`CLAUDE_BIN` 环境变量控制被调用的二进制文件，默认值为 `"claude"`（通过 PATH 查找）。当前实现通过 `spawn(CLAUDE_BIN, args)` 启动子进程，**没有任何 OS 级别沙箱**。

**关键风险：** 如果攻击者将恶意二进制文件放置在 PATH 中优先于真实 `claude`，或修改了 `CLAUDE_BIN` 指向的路径，恶意二进制将以**当前用户身份**运行，并获得与该用户完全相同的文件系统、网络、进程权限。

恶意进程可以：
- **忽略所有安全配置**：`--allowedTools`/`--disallowedTools` 只是传给 claude 的 CLI 参数，恶意二进制会直接无视这些 flag
- **访问整个文件系统**：读写当前用户有权访问的所有文件
- **建立网络连接**：发起外连、下载 payload、窃取数据
- **读取环境变量**：`sanitizeEnv()` 使用严格白名单，非白名单变量一律丢弃；但如果用户通过 `CODEX_CLAUDE_ENV_PASSTHROUGH` 配置了额外透传变量，恶意进程可读取这些变量
- **冒充正常输出**：伪造符合 Zod schema 的响应，通过 MCP 协议返回给 Codex

这等同于以当前用户身份执行任意代码。

**防范措施（按优先级）**：
- 使用绝对路径设置 `CLAUDE_BIN`，如 `CLAUDE_BIN=/opt/homebrew/bin/claude`
- 确认 `claude` 路径不能被非特权用户写入：`ls -la $(which claude)` 验证所有者为 root 或可信用户
- 确保 PATH 中 `claude` 出现的位置优先于不可信目录
- 定期运行 `codex-claude doctor` 检查 claude 路径和版本
- 考虑在操作系统层面实施额外隔离（如容器、专用用户账户）

## 已知限制

| 限制 | 影响 | 改进方向 |
|------|------|---------|
| 无 hook 级预执行策略检查 | 工具调用前无额外的策略评估点 | 可引入 PreToolUse hook 扩展点 |
| 无 MCP 通信认证 | stdio 传输无认证层 | 安全依赖 MCP 客户端控制工具暴露 |
| 纯 JSON 磁盘存储 | Run log 和 session 文件无加密 | 对高安全环境可引入文件系统级加密 |
| 无进程沙箱 | Claude 与 MCP 服务器共享用户权限 | Linux 上可考虑 seccomp/landlock |
| 旧锁回收存在理论竞态 | 本地攻击者可能强制锁回收 | 当前概率极低，文件系统 rename 提供核心保护 |
| Worktree 持久化 | 已完成的 worktree 需要手动清理 | `claude_cleanup` 工具提供手动清理能力 |

## 报告安全问题

如果你发现了安全漏洞，请通过 GitHub issue 报告（非公开）或发送邮件至项目维护者。不要公开披露。

## 安全配置检查清单

在生产环境中部署前确认：

- [ ] `CODEX_CLAUDE_ALLOW_ROOTS` 只包含具体的仓库路径，不包含 `/`、`$HOME`、`/tmp`、`/etc`
- [ ] `CODEX_CLAUDE_ENV_PASSTHROUGH`（如使用）不包含敏感变量名或敏感关键词
- [ ] `CLAUDE_BIN` 设置为绝对路径（如果 PATH 中有多个 claude 版本）
- [ ] `security_profile` 在生产任务中使用 `"strict"` 或 `"default"`，不用 `"permissive"`
- [ ] 定期运行 `codex-claude doctor` 检查配置完整性
- [ ] Review gate 在关键仓库中启用 (`claude_review_gate action=enable`)
- [ ] 定期清理过期的 worktree (`claude_cleanup`)
- [ ] 不在共享服务器上运行 MCP 服务器（无用户间隔离）
