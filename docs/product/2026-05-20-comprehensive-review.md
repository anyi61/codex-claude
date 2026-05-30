# Codex-Claude Delegate 全面审查报告

日期：2026-05-20  
仓库：`/Users/anyi/codex-claude`  
范围：安全性、功能性、易用性、工程维护性、竞品参考与产品机会  
产物性质：审查与路线图建议，不包含业务代码修改
二次复核：已合并 Claude Code 对本报告的独立复核意见，主要调整了 preview patch、并发保护、崩溃恢复、竞品范围和路线图可执行性。
三次复盘：已补充 SEC-001/SEC-002 实操中暴露的 MCP 编排层问题，包括 nested delegated worktree、`resume_latest` 会话失效、嵌套 apply metadata 和 Claude tool permission denial 的处理顺序。
维护约定：后续每完成一个 issue，都在对应问题段落、路线图条目和 issue 清单中补充“修复方式 / 验证方式 / 提交”，避免实现细节散落在对话或 git log 中。

## 1. 执行摘要

`codex-claude-delegate-mcp` 的核心方向是成立的：Codex 负责规划、验收、预览和最终落地；Claude Code 在受控命令集和隔离 git worktree 中执行读、审查、写入任务。当前项目已经具备可试用的 Beta 级基础能力，尤其是默认 5 工具、worktree 隔离、apply 前预览、`confirmed_by_user`、后台 job、doctor、MCP 结构化输出等关键链路。

但如果按“可长期给普通 Codex 用户、团队或更高信任场景使用”的标准看，当前仍有几类不足：

- **安全上**：不是强沙箱，仍主要依赖 Claude CLI permission 配置、命令白名单、worktree 和用户确认；环境变量、敏感文件读取、review gate、cleanup 与 active worktree、server 崩溃恢复、并发 implement 的边界还可以更硬。
- **功能上**：缺少事务型 apply、完整 diff preview、active job/worktree lifecycle 绑定、server 侧验证、PR/分支交付、环境准备、依赖缓存、多仓协作、CI/artifact 视图。
- **易用性上**：默认模式推断偏英文，中文任务容易误路由；高级工具配置示例、`files` 语义、project/global setup、错误下一步提示还有认知负担。
- **竞品差距上**：Cursor Cloud Agents、GitHub Copilot cloud agent、Codex CLI/Cloud、Claude Code 原生能力，以及 Aider、Cline、Devin 等参考项目，都在 diff/patch 审查、工具授权、环境隔离、PR 工作流、artifacts、hooks、权限策略、远程/云端执行方面提供了可借鉴体验。

最值得优先推进的 5 件事：

1. 做 **事务型 apply**，避免部分文件已写入但整体失败时主工作区处于半应用状态。
2. 给 implement job 持有 worktree lock，并让 cleanup 默认跳过 active job 的 worktree。
3. 让 `claude_apply preview=true` 能返回完整或可追踪的 patch/hunk，而不只是文件列表和 stat。
4. 将 review gate 与具体 write run/job/fingerprint 绑定，避免任意 review 清除 pending。
5. 修正中文/多语言任务路由，或在自动路由低置信时要求显式 `mode`。

## 2. 当前做得好的地方

### 2.1 默认工具面克制

默认配置只启用 5 个工具：`claude_setup`、`claude_task`、`claude_result`、`claude_apply`、`claude_cleanup`。这比直接暴露底层 query/review/implement/job/run 工具更适合普通用户，也降低误用概率。实现见 `src/codex-config.ts` 的 `DEFAULT_ENABLED_TOOLS`。

### 2.2 写入隔离与 apply 前确认

写入任务在 `.claude/worktrees/codex-delegated-*` 下执行，主工作区不会被 Claude 直接修改。非 preview 的 `claude_apply` 要求 `confirmed_by_user=true`，并且在 metadata 缺失、scope exceeded、resource exceeded、主工作区冲突等场景 fail closed。

关键证据：

- `src/claude-cli.ts:1568-1581` 创建/准备 delegated worktree。
- `src/claude-cli.ts:1811-1823` 强制非 preview apply 必须确认。
- `src/claude-cli.ts:1851-1863` metadata 缺失时拒绝 apply。
- `src/claude-cli.ts:1899-1929` resource/scope 超限时拒绝 apply。
- `src/claude-cli.ts:1931-1951` 主工作区冲突或不支持状态时拒绝 apply。

### 2.3 命令白名单和安全 profile 已经有清晰层级

默认 `security_profile="default"` 不允许 `npx *`，`strict` 更收窄，`permissive` 才允许 `npx *`。这比早期“默认可远程包执行”的风险小很多。实现见 `src/claude-cli.ts:1107-1196`。

### 2.4 MCP 输出和交互提示已有基础契约

工具定义包含 title、annotations、outputSchema，`jsonResult()` 和 `errorResult()` 同时返回 text JSON 与 `structuredContent`。`claude_task`、`claude_apply`、`claude_cleanup` 等也返回 `interaction`，对 Codex 下一步行动有帮助。

### 2.5 诊断和文档一致性已显著改善

`codex-claude doctor` 检查 Node、包信息、Claude CLI、Git、Codex config、默认工具、allow roots、tool timeout、MCP launch smoke。`npm run audit:docs` 已用于防止默认工具数量等文档漂移。`docs/AUDIT_FIX_COMPLETION.md` 记录了这些改进。

## 3. 安全性审查

### S1. 当前不是强沙箱，边界需要继续写清楚并测试

项目文档已经明确“它不是强沙箱”。实现上，Claude CLI 以 `--permission-mode dontAsk` 运行，然后靠 `--allowedTools` / `--disallowedTools`、worktree、env sanitization、apply 确认来收窄风险。这个设计适合作为本地可信仓库的纵深防御，但不能等价于容器、VM 或 OS 级 sandbox。

证据：

- `src/claude-process.ts:96-130` 设置 `--permission-mode dontAsk`、`--allowedTools`、`--disallowedTools`。
- `SECURITY.md` 已说明本项目不是强沙箱。

建议：

- 在 `claude_setup` / doctor 输出中加入更短的 risk label：`local_process_not_hard_sandboxed=true`。
- 增加 adversarial tests：尝试读 `../outside-file`、`.env`、发起网络命令、绕过 `rm` pattern，验证 Claude CLI 实际拒绝。
- 为高风险团队用例提供 `strict + sandboxed claude` 安装建议。

### S2. 环境变量清理仍是黑名单为主，容易漏掉自定义敏感变量

`sanitizeEnv()` 先保留一批安全变量，然后过滤显式危险 key 和包含 `SECRET`、`TOKEN`、`CREDENTIAL`、`PASSWORD`、`API_KEY` 的变量，其他变量默认透传。`SECURITY.md` 已承认 `DATABASE_URL`、`COOKIE`、自定义凭据名可能不会被剥离。

证据：

- `src/guard.ts:229-259` 当前 sanitization 逻辑。
- `SECURITY.md` 的“其余变量默认透传”说明。

风险：

- `DATABASE_URL`、`SESSION_COOKIE`、`PRIVATE_KEY_PATH`、`SENTRY_DSN`、`AUTH_HEADER`、`OAUTH_CLIENT_SECRET` 这类变量可能穿透。
- Claude 子进程可通过允许的 `node` / `python` 读取环境并写入日志或代码。

建议：

- 默认改为严格 allowlist：`PATH`、`HOME`、`SHELL`、`LANG`、`LC_*`、`TERM`、`TMP*`、`NODE_ENV`、必要代理变量。
- 新增 `CODEX_CLAUDE_ENV_PASSTHROUGH=VAR1,VAR2` 作为显式 opt-in。
- 额外过滤关键词：`AUTH`、`COOKIE`、`SESSION`、`PRIVATE`、`KEY`、`DATABASE_URL`、`DSN`。
- run log 写入前对 `input.task` / `diff` / `report` 提供可选 redaction。

状态：已修复，提交 `9e3a629 fix: enforce strict env passthrough`。本轮完成严格 env allowlist 与显式 passthrough；run log 内容 redaction 保留为后续独立项。

修复方式：

- `sanitizeEnv()` 改为默认只转发 16 个允许变量：`PATH`、`HOME`、`SHELL`、`LANG`、`LC_ALL`、`LC_CTYPE`、`TERM`、`USER`、`TMPDIR`、`TEMP`、`TMP`、`NODE_ENV`、`HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`、`ANTHROPIC_BASE_URL`。
- 新增 `CODEX_CLAUDE_ENV_PASSTHROUGH`，逗号分隔、大小写敏感、变量名 regex 校验、去重；该控制变量本身从不转发。
- passthrough 中的敏感 exact/keyword 名称被强制拦截，包括 `DATABASE_URL`、`DSN`、已知 token/key 名称，以及 `AUTH`、`COOKIE`、`SESSION`、`PRIVATE`、`KEY`、`SECRET`、`TOKEN`、`CREDENTIAL`、`PASSWORD`、`API_KEY`。
- doctor 增加 `checks.env_sanitization` 与文本摘要，展示 allowlisted/passthrough/blocked 的类别、计数和名称，不展示变量值；blocked passthrough 不会让 doctor 变成 `not_ready`。
- README 与 SECURITY 已同步为严格白名单说明，移除“其余变量默认透传”的陈旧说法。

验证：

- `npm test -- tests/guard.test.ts tests/cli.test.ts tests/claude-cli.test.ts`：通过，3 个测试文件 195 个测试全过。
- `npm run typecheck`：通过。
- `npm run audit:docs`：通过。
- `git diff --check`：通过。
- `npm run build && npm test`：通过，21 个测试文件 589 个测试全过。

### S3. 敏感文件读取策略不够硬

状态：已修复，提交 `8c9c574 fix: deny sensitive file reads`。

修复方式：

- 新增 `sensitive_file_policy`，覆盖 `claude_task`、`claude_query`、`claude_review`、`claude_implement`，取值为 `default` / `strict` / `off`。
- 默认策略注入 `Read`/`Grep`/`Glob` deny 以及 `Bash(cat/head/tail/grep ...)` 读取绕过 deny，覆盖根目录与子目录 `.env` / `.env.*` 和 `secrets/**`。
- strict 策略额外覆盖 key/cert、SSH/AWS/GPG/Kube/Docker 配置、`.netrc`/`.npmrc`/`.pypirc`、`credentials*` 等常见秘密存储；off 仅移除敏感文件 deny，不移除危险 Bash deny。
- 后台任务指纹将省略策略与显式 `default` 归一，避免重复排队；README/SECURITY 同步说明策略边界。

验证：

- `npm run typecheck`
- `npx vitest run tests/schema.test.ts tests/claude-cli.test.ts tests/server.test.ts tests/background-jobs.test.ts`
- `npm run audit:docs`
- `git diff --check`
- `npm run build && npm test`（doctor smoke flaky 失败，精确用例 `npx vitest run tests/cli.test.ts -t "returns structured doctor --json output"` 重跑通过）

当前 server 验证的是用户传入的 `instruction_files` / `files` 是否在 cwd 内，但 Claude 内部通过 `Read`、`Glob`、`Grep` 访问哪些文件，主要交给 Claude Code 自身权限模型。项目没有显式设置类似 `Read(./.env)`、`Read(./secrets/**)` 的 deny policy。

证据：

- `src/server.ts:719-727` 只检查传入上下文文件路径。
- `src/claude-cli.ts:1060-1077` read 模式允许 `Read`、`Glob`、`Grep`。
- `src/claude-cli.ts:1115-1117` write 模式允许 `Read`、`Glob`、`Grep`、`Edit`、`Write`、`Bash`。

竞品/底层参考：

- Claude Code settings 支持 `permissions.deny`，示例包括 `Read(./.env)`、`Read(./secrets/**)`，也支持 sandbox filesystem/network 策略。

建议：

- 默认把 `.env`、`.env.*`、`*.pem`、`*.key`、`secrets/**`、`.aws/**`、`.ssh/**`、`config/credentials*` 加入 deny。
- 提供 `sensitive_file_policy`：`default` / `strict` / `off`。
- 在 `claude_setup` 中检测仓库是否存在 `.env` 等文件，提示当前策略。

### S4. `claude_apply` 不是事务型，存在部分应用风险

状态：已修复，提交 `dbd12c0 fix: make claude_apply transactional`。

当前 apply 在预检通过后逐文件复制或删除。如果前几个文件已经写入主工作区，后续文件写入失败，函数会记录 conflicts，但不会回滚已写入文件。更糟的是，只要 `copied.length > 0`，最终不会返回 `error`，上层 interaction 会显示“Delegated changes applied”。

证据：

- `src/claude-cli.ts:1964-1988` 逐文件写入，失败只 push 到 `conflicts`。
- `src/server.ts:903-908` 只要 `applied_files.length > 0` 就认为已应用。

风险：

- 磁盘、权限、路径类型、并发修改等异常会让主工作区处于半应用状态。
- 用户看到“已应用”后可能直接继续测试，难以意识到某些文件失败。

建议：

- 应用前为每个目标文件记录 backup 或 temp path。
- 先验证所有 source 可读、目标目录可写，再统一 commit copy。
- 任意文件失败时自动 rollback 已写入文件，并返回 `error`。
- 若仍选择 best-effort apply，必须在有 conflicts 时 `error="Partial apply"`，interaction 不得显示 applied success。

（以上为 2026-05-20 原始建议，已在下方修复方式中落地。）

修复方式：

- 新增 `src/transaction.ts`，把 apply 拆成预检、backup、commit copy/delete、rollback、recovery reporting 几个明确阶段。
- `claude_apply` 在写入主工作区前先建立目标文件备份，任一 copy/delete 失败时自动回滚已经修改的路径。
- 回滚失败时返回结构化 `dirty_recovery_needed` 信息，列出已应用、已回滚、回滚失败文件，避免把半应用状态包装成成功。
- `src/server.ts` 的 interaction 成功判定改为尊重 apply error/conflicts/recovery 状态，禁止有冲突时显示成功。
- 测试覆盖 copy 失败、delete 失败、权限/目录异常、rollback 失败、server interaction 文案和 schema 字段。

验证方式：

- `npm run typecheck`
- `npx vitest run tests/transaction.test.ts tests/claude-cli.test.ts tests/server.test.ts`

### S5. cleanup 可能移除 active implement worktree

状态：已修复，提交 `b8d75dd fix: lock active implement worktrees`。

`claude_cleanup` 会扫描 `.claude/worktrees/codex-delegated-*` 并在 `dry_run=false` 时强制 `git worktree remove --force`。apply/cleanup 之间有 lock，但 implement job 创建/使用 worktree 时没有持有同一个 worktree lock，因此用户或另一个 agent 可能清理仍在运行的 write job worktree。

证据：

- `src/claude-cli.ts:1568-1581` implement 准备 worktree，没有 acquire worktree lock。
- `src/claude-cli.ts:2011-2114` cleanup 删除 delegated worktrees。
- `src/claude-cli.ts:2078-2109` cleanup 只与 apply/cleanup 互斥，不与 implement 互斥。

建议：

- implement 从创建 worktree 到 Claude 结束期间持有 `worktree:<name>` lock。
- cleanup 删除前查询 active jobs，跳过 active job 绑定的 worktree。
- cleanup preview 增加 `active_job_id`、`last_run_id`、`safe_to_remove` 字段。

（以上为 2026-05-20 原始建议，已在下方修复方式中落地。）

修复方式：

- implement 从 worktree 准备开始到 Claude 执行结束期间持有同名 `worktree:<name>` lock，和 apply/cleanup 使用同一互斥边界。
- background implement job 在创建/确定 worktree 后尽早把 `worktree_name` 写入 job record，cleanup 能在长任务期间识别 active owner。
- cleanup 在 dry-run 和实际删除前都会查询 active implement jobs；命中 active worktree 时返回 skipped，并附带 `active_job_id`、`safe_to_remove=false`。
- apply/cleanup 遇到 worktree lock busy 时，错误文案明确提示可能有 implement/apply/cleanup 正在使用该 worktree。
- 测试覆盖 active job 跳过、job-runner 早写 worktree_name、lock busy 文案和 cleanup schema。

验证方式：

- `npm run typecheck`
- `npx vitest run tests/lock.test.ts tests/jobs.test.ts tests/background-jobs.test.ts tests/claude-cli.test.ts`
- `npm test`

### S6. review gate 是软提醒，且与具体 write 无绑定

状态：已修复，提交 `94aedc6 fix: bind review gate to reviewed runs`。

review gate 目前是 soft-stop。更重要的是，任何 review 完成都会 `markReviewGatePending(input.cwd, false, "review")`，没有验证该 review 是否覆盖最新 write job 或 apply diff。一个无关 review 可能清除 pending 状态。

证据：

- `src/review-gate.ts:20-21` 使用 repo-local state 和 stop hook。
- `src/claude-cli.ts:1516-1520` review 成功后清 pending。
- `plugins/codex-claude-delegate/hooks/review-gate-stop.mjs:50-63` 输出提醒 payload，但不是强制审批系统。

建议：

- pending state 记录 `write_job_id`、`run_id`、`worktree_name`、`changed_files_hash`。
- review 请求必须引用对应 run/job 或 diff hash，匹配后才清 pending。
- 对 apply 后的主工作区 diff 也应重新置 pending，直到 post-apply review 或测试完成。

已完成修复方式：

- `ReviewGateState` 新增 pending metadata：`pending_activity`、`pending_run_id`、`pending_worktree_path`、`pending_fingerprint`、`last_cleared_by_review_run_id`。
- `markReviewGatePending` 改为只负责写入 pending metadata；清除逻辑统一走 `clearReviewGatePendingIfMatches`。
- `runClaudeReview` 只有在显式传入匹配的 `reviewed_run_id`，以及可选 `reviewed_worktree_path` 也匹配时，才清除 pending。
- `startBackgroundReview` 不再在任务排队时清 pending；后台 review 只有实际成功执行并匹配 pending run 时才会清。
- `runClaudeImplement` 和成功的非 preview `runClaudeApply` 会记录待审查 run metadata；preview、失败 apply、零 applied files 不会设置 apply pending。
- 旧版 `review-gate.json` 中没有新增字段时仍可正常 status/enable/disable。

已验证：

- `npm run typecheck`
- `npx vitest run tests/review-gate.test.ts tests/schema.test.ts tests/server.test.ts tests/claude-cli.test.ts`
- `npm run build && npm test`：全量运行中既有 doctor smoke flaky 失败 1 个用例，单独重跑 `npx vitest run tests/cli.test.ts -t "returns structured doctor --json output"` 通过；其他 505 个用例通过。
- `npm run audit:docs`

### S7. allow roots 对危险目录子路径可覆盖，适合开发但需更强提示

`validateCwd()` 拒绝危险根目录本身，但允许 `CODEX_CLAUDE_ALLOW_ROOTS` 覆盖危险目录子路径，例如 macOS `/var/folders/...` 或 `/tmp/...` 下的临时仓库。这支持测试和特殊路径，但如果用户把共享临时目录加入 allow roots，风险会变高。

证据：

- `src/guard.ts:102-122` exact dangerous root 不可覆盖，prefix dangerous root 可被 allow roots 覆盖。
- `tests/guard.test.ts` 覆盖了 temp 目录 override。

建议：

- `configure_allow_root` 遇到 `/tmp`、`/var`、`/usr`、`/opt` 子目录时返回 warning，并要求显式 `allow_dangerous_subdir=true` 或 CLI `--force-dangerous-subdir`。
- doctor 标出 allow roots 中的共享/临时路径。

### S8. 本地状态文件明文存储，权限和保留策略可加强

run logs、job records、session store 都是明文 JSON，记录 task、diff、Claude report、stdout/stderr tail、session_id 等。`cleanupDelegateArtifacts()` 已存在，但不是默认用户能直接发现的主路径。

证据：

- `src/run-logs.ts:105-113` 直接写 run log JSON。
- `src/session.ts:51-53` session store 文件路径。
- `src/claude-cli.ts:728-799` 有 artifact cleanup helper。

建议：

- `.codex-claude-delegate` 创建时设置目录权限 `0700`。
- 默认保留策略：run logs 30 天或 500 条，job records 30 天，session 24 小时。
- 把 `cleanupDelegateArtifacts()` 暴露为 CLI 维护命令，例如 `codex-claude cleanup-artifacts --dry-run`。

### S9. MCP server 崩溃恢复路径不完整

如果 MCP server 在 implement 任务运行中崩溃，Claude 子进程可能继续运行，后台 job 记录仍停留在 running，worktree 生命周期也会变得不清晰。`background-jobs.ts` 已有 heartbeat/stale detection，但缺少 server 启动时的 orphan recovery 和用户可见恢复路径。

风险：

- Claude 子进程继续消耗 API 额度，但用户界面已经失去实时状态。
- worktree、job、run log 状态不一致，后续 apply/cleanup 的安全判断变弱。
- 用户不知道应该等待、终止、恢复还是清理。

建议：

- server 启动时扫描 running jobs，检查 PID 是否存活、heartbeat 是否过期、worktree 是否存在。
- 对无存活 PID 的 job 标记为 `crashed`，并保留 worktree 供用户 inspect/apply/cleanup。
- `claude_workspace_status` 展示 `crashed_jobs` 和下一步建议。
- 对仍存活但 server 曾崩溃的 Claude 进程，提供 `reattach` 或明确的 `terminate/inspect` 路径。

状态：部分修复。`SEC-006` 已完成，提交 `b00ce5e fix: recover crashed background jobs`；仍存活 PID 的 reattach/terminate 路径保留给后续并发/进程管理项。

修复方式：

- 新增 background job 状态 `crashed`，作为 terminal 状态处理；`claude_task(job_id=...)`、wait、cancel、cleanup、dedupe、worktree active lookup 均按 terminal 语义处理，不再把 crashed job 当 active duplicate。
- server startup 以 best-effort 方式触发 `recoverCrashedJobsOnStartup()`；失败被吞掉，不阻塞 MCP stdio 启动。
- `recoverCrashedJobs()` 扫描 active queued/running jobs；dead pid 或缺失 pid 且超过保守 grace/stale 阈值时标记为 `crashed`，保留 `run_id`、`worktree_name`、payload/result，不删除 run log 或 worktree。
- live PID 优先级高于 stale heartbeat；即使 heartbeat 很旧，只要 PID 仍存活就不标 crashed，避免误伤仍在执行或 PID reuse 场景。
- `claude_workspace_status` 新增 `crashed_jobs`、`counts.crashed_jobs`、`crashed_job` attention；无 active job 时给 `claude_job_result` inspect 和 retained worktree `claude_apply preview=true` next action。

已验证：

- `npm run typecheck`
- `npx vitest run tests/background-jobs.test.ts tests/jobs.test.ts tests/claude-cli.test.ts tests/server.test.ts tests/schema.test.ts`
- `npm run audit:docs`
- `git diff --check`
- `npm run build && npm test`（doctor smoke flaky 失败，精确用例 `npx vitest run tests/cli.test.ts -t "returns structured doctor --json output"` 重跑通过）

### S10. implement 并发缺少总量保护

当前后台任务机制允许同时启动多个 implement job。单个 job 有 `max_turns`、`max_cost_usd` 和 security profile，但没有控制同一仓库或全局的并发数量。对个人机器和 API 账单来说，这是一类现实风险。

建议：

- 默认同一 repo `max_concurrent_implements=1`，多余请求返回 busy 或排队。
- 可配置全局并发上限，并在 `claude_setup`/doctor 输出当前 active Claude 进程数。
- job 结果中说明是新建、排队、还是复用 dedup job。
- 对 read/review/write 分别计数，避免只读查询被写入任务完全阻塞。

状态：已修复，提交 `03c56fc fix: limit concurrent implement jobs`。本轮选择默认 busy 而不是隐藏排队；全局可配置上限仍保留为后续扩展。

修复方式：

- `MAX_CONCURRENT_IMPLEMENTS=1`；同一 repo 的 implement 请求在 fingerprint dedupe 后、创建 job/spawn 前检查 active implement。
- 新请求与已有 active implement 指纹相同则保持 `deduped=true` 复用；指纹不同则返回现有 job、`do_not_start_duplicate_job=true` 和 `concurrency.busy/max_concurrent_implements/active_implements`，不 spawn 第二个 runner。
- `query/review/apply/cleanup` 不受 implement cap 阻塞；terminal/crashed implement 不占用并发。
- `claude_workspace_status` 增加 `active_processes`、`counts.active_implement_jobs`、`counts.active_claude_processes`；doctor 增加 best-effort `checks.active_claude_processes` 和文本输出。这里的 active process 是持久化 background job runner PID，对 Claude CLI 子进程是代理信号，不直接承诺子进程 PID。

验证：

- `npx vitest run tests/background-jobs.test.ts tests/workflow-results.test.ts tests/cli.test.ts tests/server.test.ts`：新增/相关测试通过；期间已知 `tests/cli.test.ts > returns structured doctor --json output` 偶发失败，精确重跑通过。
- `npm run typecheck`：通过。
- `npm run audit:docs`：通过。
- `git diff --check`：通过。
- `npm run build && npm test`：build 通过；全量测试仅同一已知 doctor smoke flaky 失败，精确重跑通过；其余 574/575 通过。

### S11. preview/apply 对 `.gitignore` 与 ignored 文件缺少提示

`claude_apply` 基于 worktree diff 逐文件复制到主工作区，但 preview 中没有标出目标文件是否会被 `.gitignore` 忽略。结果可能是 apply 后生成了用户难以追踪的 ignored 文件，或让用户以为变更会进入版本控制，实际不会。

建议：

- preview 阶段对 planned changes 调用 `git check-ignore`。
- 对 ignored 文件返回 `ignored_by_git=true`、匹配规则和来源文件。
- 默认允许用户显式确认 ignored artifact；对 `.env*`、key/cert 等敏感模式仍应被 deny policy 拦截。

### S12. submodule 场景没有显式策略

当前报告已提到 rename/copy 支持不足，但没有覆盖 git submodule。`git worktree` 与 submodule 的组合会带来额外状态：submodule 是否初始化、gitlink 是否变更、apply 是否应该复制子模块内容或只更新 gitlink。没有策略时，最安全的行为是检测并拒绝或警告。

建议：

- doctor 检测 `.gitmodules` 并输出“submodule write support limited”。
- preview 中标记 submodule/gitlink 变更，默认拒绝 apply。
- P2 再考虑只读 review submodule 内容；写入仍应要求用户显式确认。

### S13. MCP 编排层缺少 nested worktree、resume 失效和工具权限的显式保护

状态：已完成。`SEC-008` 已完成，提交 `4e173a3 fix: reject nested delegated write worktrees`；`SEC-009` 已完成，提交 `1a4d534 fix: retry expired implement resume sessions`；`UX-006` 已完成，提交 `11ddd68 fix: surface apply and permission warnings`。

SEC-001/SEC-002 的实际协作暴露出一组更偏“编排层”的问题。它们不是单个实现 bug，而是 MCP 对 cwd、session、worktree metadata 和 Claude CLI 权限状态的边界表达还不够硬。

实操证据：

- 当 `cwd` 被传成已有 delegated worktree 时，MCP 会把它当成普通 git repo，再在其下创建新的 `.claude/worktrees/codex-delegated-*`，形成 nested worktree，例如 `.claude/worktrees/codex-delegated-1c7a7a29/.claude/worktrees/codex-delegated-739832e0`。
- 历史记录中也出现过类似 nested worktree，说明这不是一次性误操作。
- 多个 `resume_latest` job 使用本地记录的 `returned_session_id` 后，Claude CLI 返回 `No conversation found with session ID: ...`，MCP 只能失败后被动 `markExpired`。
- 对 nested worktree 从主 repo 执行 `claude_apply` 时，apply 找不到 implement metadata，因为 run log 按 `cwd` 分区存储，嵌套 worktree 的 metadata 写在上一层 delegated worktree 下。
- Claude structured output 多次包含 `permission_denials`，说明 delegated Claude 可能尝试运行验证命令但被自身权限策略拒绝；如果 MCP 不显式提升该信息，用户会误以为 Claude 已完成验证。

根因：

- `validateCwd()` 只验证路径存在、在 allow roots 内、是目录；`supportsWorktree()` 只验证 git worktree 命令可用。delegated worktree 本身也是合法 git worktree，因此会通过检查。
- session store 和 run log 只能证明 MCP 曾经收到 Claude 返回的 session id，不能证明 Claude CLI 侧仍保留该 conversation。
- `claude_apply` 当前假设目标 worktree 是当前 `cwd` 的直属 `.claude/worktrees/<name>`。nested path 破坏了这个假设，跨 workspace 追踪 metadata 又容易误匹配。
- Claude CLI 的 permission denial 是运行结果的一部分，但当前 MCP 对它的产品化表达不够显眼。

建议：

- P0：新增 `isDelegatedWorktreePath(cwd)`，用路径段检测 `.claude/worktrees/codex-delegated-*`，并在 `claude_task(mode=write)` 和 `claude_implement` 入口拒绝 nested implement。不要自动解析回主 repo root，避免猜错。
- P0：`resolveLatestImplementSession` 只选择近期 session；`runClaudeImplement` 在 `No conversation found` 时标记 expired，并在同一已准备 worktree 内最多 retry 一次 fresh implement。retry 前必须清掉 `session_key`，保留 dirty snapshot 和 worktree lock。
- P1：`runClaudeApply` 检测 `worktree_path` 是否包含多段 `.claude/worktrees/`，命中时返回明确错误：nested delegated worktrees unsupported；不要跨 workspace 查找 metadata。
- P1：从 Claude parsed output 中提取 `permission_denials`，在 implement result warnings 中提示用户/Codex 需要本地重跑验证。不要在 `claude_status` 中默认执行 Bash smoke test，避免把无副作用诊断变成会执行命令的操作。

（以上为 2026-05-20 原始建议，其中 `SEC-008`、`SEC-009` 和 `UX-006` 已在下方修复方式中落地。）

已完成修复方式：

- 新增 `isDelegatedWorktreePath(cwd)`，用路径段识别连续 `.claude/worktrees/codex-delegated-*`，避免普通目录名误判。
- `claude_implement` 在 delegated worktree cwd 内直接拒绝 write。
- `claude_task` 对显式 `mode="write"`、`resume_latest`、`constraints`、以及 auto 推断出的写入任务同样拒绝 nested write。
- read/review 路径不受影响；带 diff 的 review 仍允许在 delegated worktree 内执行，避免过度拦截排障审查。
- 测试覆盖显式 write、auto inferred write、resume_latest/constraints 触发写入、read/review 放行、路径段误判边界。
- `resolveLatestImplementSession` 不再只信 run log；它会用 session store 验证候选 session，跳过 missing、expired 和 `last_used` 超过 `RECENT_WINDOW_MINUTES` 的旧 session。
- `runClaudeImplement` 在 resume session 返回 `No conversation found with session ID` 时先 `markExpired`，再在同一个已准备 worktree 内做一次 fresh retry；retry 清掉 `session_key`，保留 dirty snapshot、scaffold、worktree lock 和同一个 run/job 追踪。
- fresh retry 成功时 result warnings 明确提示 `resume_latest` session 不可用并已 fallback；fresh retry 失败时直接返回 failed，不递归、不二次 retry；非 session-not-found 错误不 fallback。
- 测试覆盖 session store 过滤、expired/stale 跳过、recent session 命中、fallback 成功、fallback 不创建第二个 worktree、fallback 失败不二次 retry、非 session-not-found 不 fallback。
- `runClaudeApply` 在 apply 前检测多段 `.claude/worktrees/codex-delegated-*`，命中 nested delegated worktree path 时 fail closed，并返回可操作的 nested apply 不支持错误；普通单层 delegated worktree apply 不受影响。
- `spawnClaude` 在 Claude 返回 `structured_output` 时保留顶层 `permission_denials`，避免该字段被结构化结果遮蔽；如果 `structured_output` 自带 `permission_denials`，则优先保留结构化结果。
- `runClaudeImplement` 将 `permission_denials` 汇总为 warning，展示 denial 数量和去重后的工具名，提示本地重跑验证；warning 不改变 implement status，也不泄漏 `tool_input` 等敏感参数。

已完成验证方式：

- `npm run typecheck`
- `npx vitest run tests/guard.test.ts tests/server.test.ts`
- `npm test` 首次仅 `tests/cli.test.ts` doctor launch smoke 偶发失败；随后精确重跑 `npx vitest run tests/cli.test.ts -t "returns structured doctor --json output"` 通过。
- `SEC-009` 验证：`npm run typecheck`；`npx vitest run tests/claude-cli.test.ts`；`npx vitest run tests/session.test.ts tests/claude-cli.test.ts`。
- `UX-006` 验证：`npm run typecheck`；`npx vitest run tests/claude-cli.test.ts tests/claude-process.test.ts tests/schema.test.ts tests/server.test.ts`；`npm run audit:docs`；`git diff --check`；`npm run build && npm test`（doctor smoke flaky 失败，精确用例第二次重跑通过）。

验收测试：

- `claude_implement` 和 `claude_task(mode=write)` 在 delegated worktree cwd 内被拒绝；read/review 路径不受影响。
- 路径中普通目录名包含 `codex-delegated-*` 但不位于 `.claude/worktrees/` 段落时不误判。
- 过旧 session 不会被 `resume_latest` 选中；session not found 只 retry 一次 fresh implement，并返回 fallback warning。
- nested apply path 返回清晰错误；普通单层 delegated worktree apply 不受影响。
- Claude output 含 `permission_denials` 时，result warnings 包含可操作提示；无 denial 时不增加噪音。

## 4. 功能性审查

### F1. 自动 mode 推断偏英文，中文任务容易误路由

`inferClaudeTaskMode()` 的 write/review/read hints 基本都是英文。对中文用户来说，“修复 bug”“新增测试”“审查安全风险”“解释架构”这类任务可能默认落到 read，导致没有执行写入或审查。

证据：

- `src/claude-cli.ts:176-207` 自动路由 regex。
- README 和用户群明显偏中文，但关键词没有中文覆盖。

建议：

- 增加中文关键词：`修复`、`修改`、`实现`、`新增`、`添加`、`重构`、`更新`、`补充`、`审查`、`评审`、`检查`、`找问题`、`解释`、`总结`、`分析`。
- 对 auto 模式输出 `mode_inference={mode, confidence, matched_terms}`。
- 低置信时返回 `needs_user`，要求显式 `mode`。

### F2. 高层 `claude_task` 缺少硬 scope 控制

README 说明 `claude_task.files` 已废弃，只作为 instruction context，不是 apply scope。严格文件范围只能用 Advanced `claude_implement.files`。这降低了普通路径的安全性和易用性：用户最常用的高层工具反而不能表达“只允许改这些文件”。

证据：

- `src/claude-cli.ts:213-224` 将 `claude_task.files` 合并为 instruction files。
- `src/claude-cli.ts:464-473` high-level write 没把 `files` 传给 implement。
- `src/run-logs.ts:95-102` 和 observe/apply 已具备 requested files/scope 机制。

建议：

- 新增 `claude_task.allowed_files`，语义明确为硬 scope。
- `files` 保持 deprecated，不再复用。
- 支持 `max_changed_files` 在 high-level `claude_task` 直传。
- 默认 preview 中显示 `out_of_scope_files`。
- 优先级建议调整为 P1 顶部：这是重要的安全/UX 能力，但高级 `claude_implement.files` 目前已有替代路径，风险低于事务型 apply、active lock、完整 preview 和中文误路由。

### F3. preview 只有 planned changes 和 stat，不足以做内容审查

状态：已修复，提交 `be94110 feat: add patch output to apply preview`。

`claude_apply preview=true` 返回 `planned_changes` 和 `diff_stat`，但没有完整 patch/hunk。用户需要额外进入 worktree 或运行 git diff 才能审查内容。对“应用前预览”来说，文件列表不是充分证据。

证据：

- `src/schema.ts:470-477` apply result 只有 `applied_files`、`diff_stat`、`conflicts`、`planned_changes`。
- `src/claude-cli.ts:1953-1961` preview 返回 planned changes，不返回 patch。

建议：

- 增加 `include_patch=true`，默认返回截断 patch 和 hash。
- 大 diff 返回 `patch_truncated=true`、`patch_path`、`diff_sha256`。
- 提供 `claude_apply preview=true format=summary|patch|json`。
- 优先级建议上调为 P0：`confirmed_by_user` 强制确认只有在用户能看到实际内容时才有安全意义。否则确认的是流程信任，而不是变更内容。

已完成修复方式：

- `claude_apply` 新增 `include_patch` 和 `patch_max_bytes` 输入；`patch_max_bytes` 限制为 `1024..500000`，未传时运行时默认 `60000`。
- preview 结果新增 `patch`、`patch_truncated`、`patch_path`、`diff_sha256`、`patch_bytes`、`untracked_not_in_patch`。
- `include_patch=true` 时生成 scoped `git diff --binary` patch，并对完整 patch 字节计算 SHA-256；大 patch 写入 `.claude/patches/<runId>.patch`。
- 未跟踪文件仍出现在 `planned_changes`，但第一阶段不伪造非标准 patch；当 planned changes 含未跟踪文件时返回 `untracked_not_in_patch=true`，避免静默遗漏。
- patch 生成失败不再被当作空 patch；preview 返回明确错误且不修改主工作区。

已验证：

- `npm run typecheck`
- `npx vitest run tests/schema.test.ts tests/server.test.ts tests/claude-cli.test.ts`
- `npm run build && npm test`：全量首次运行因既有 doctor smoke flaky 失败 1 个用例，单独重跑 `npx vitest run tests/cli.test.ts -t "returns structured doctor --json output"` 通过；其他 488 个用例通过。
- `npm run audit:docs`

### F4. apply 只支持 A/M/D，不支持 rename/copy/submodule 等状态

当前 apply 明确只接受 `A`、`M`、`D`。这很安全，但功能上会拒绝常见 git rename/copy。对于文档重命名、模块搬迁、文件大小写变化，体验会比较硬。

证据：

- `src/claude-cli.ts:1933-1939` valid statuses 只有 A/M/D。

建议：

- P1 继续保持保守拒绝。
- P2 支持 rename：先预览 `R old -> new`，应用时删除 old、写入 new，必须有 tests。

### F5. 工作环境准备能力弱于云端竞品

写入模式禁止 `npm install`、`pip install`、`yarn add`、`pnpm add/remove` 等，这是安全上合理的。但很多仓库需要依赖安装、服务启动、Docker、浏览器测试。当前项目没有类似 Cursor Cloud Agents 的 environment setup、snapshot、Dockerfile、startup command、tmux terminals、secrets management。

建议：

- 增加“受控 setup phase”：只在用户显式允许时运行仓库白名单 setup 命令。
- 支持 `.codex-claude-delegate/environment.json`，字段包括 `install`、`test`、`start`、`symlink_directories`、`sparse_paths`。
- 默认仍不运行 install；doctor 只提示缺失依赖与建议命令。

### F6. 缺少 branch/PR 交付路径

当前交付是 worktree -> preview -> copy files 到主工作区。这对本地个人流很好，但团队协作更习惯 branch/commit/PR。竞品普遍把 agent 工作落到 branch 或 PR 上。

建议：

- 新增 `claude_export` 或 `codex-claude export-pr`：
  - 从 delegated worktree 创建 branch。
  - 可选 commit message。
  - 可选 `gh pr create --draft`。
  - 默认不 push，除非用户确认。

### F7. 缺少服务端验证与 artifacts

状态：部分修复，提交 `f5b2a17 feat: add server verification commands`。本次完成 server-side verification；artifacts 汇总仍留给 P2。

修复方式：

- `claude_task` 写入模式与 `claude_implement` 新增 `verification_commands`。
- Claude 完成后，server 在 delegated worktree 内按顺序运行受控验证命令；结果进入 `server_verified`，包含每条命令的 status、exit code、耗时、stdout/stderr tail 和 timeout 信息。
- 命令解析为 argv 后通过 `spawn(command, args)` 执行，不使用 shell；仅允许测试/类型检查/lint 类命令族，并拒绝 install/publish/deploy/start/serve、删除、提权、网络拉取等危险语义。
- server verification 失败会把原本的 success 降为 `partial` 并保留 worktree；不会自动 apply 或 cleanup。
- 后台 job fingerprint 纳入归一化后的 `verification_commands`，避免不同验证要求误复用同一 active job。

验证：

- `npm run typecheck`
- `npx vitest run tests/verification.test.ts tests/server.test.ts tests/background-jobs.test.ts tests/claude-cli.test.ts tests/schema.test.ts`
- `npm run audit:docs`
- `git diff --check`
- `npm run build && npm test`（doctor smoke flaky 失败，精确用例 `npx vitest run tests/cli.test.ts -t "returns structured doctor --json output"` 重跑通过）

Claude report 中包含 tests 字段，但这是 Claude 自报。server 目前没有独立运行用户指定验证命令，也没有截图、日志、测试报告、视频等 artifacts 汇总。Cursor Cloud Agents 已把 artifacts 和远程桌面作为核心体验。

建议：

- `claude_task` 支持 `verification_commands`，由 server 在 worktree 中运行白名单命令，结果进入 `server_verified`。
- 保存 junit、coverage、screenshots、playwright traces 的相对路径。
- apply 后建议或自动运行主工作区 verification，默认 ask。

### F8. 多仓/monorepo 支持有限

当前 `cwd` 是单仓边界，worktree 也在单仓下。Cursor 支持 multi-repo environments，GitHub Copilot cloud agent 依托 GitHub Actions 环境。对前后端分仓、infra 分仓、shared library 分仓，本项目需要用户手动协调。

建议：

- P2 支持 `workspace_roots`，每个 root 独立 allow/scope/apply。
- 先从只读 multi-root query/review 开始，write 仍单 repo。

### F9. 任务 idempotency 和 dedup 语义不够可见

任务 fingerprint/dedup 能减少重复启动，但用户重试失败任务时不容易判断系统是复用旧 job、创建新 job，还是命中了一个 worktree 已被清理的旧记录。这会影响恢复和排障体验。

建议：

- `claude_task` 返回 `dedup_policy`、`dedup_decision` 和复用原因。
- 复用旧 job 时展示 worktree 是否仍存在、是否可 apply、是否需要 cleanup。
- 对 failed/crashed job 默认不静默复用，除非用户显式 `resume_latest` 或 `job_id`。

### F10. 工具调用级 audit trail 不足

run log 已记录任务级元数据、stdout/stderr tail、report 等，但没有 delegate 层可读的 Claude 内部工具调用轨迹，例如 Read/Bash/Edit/Write 的目标路径和命令摘要。安全审计时需要跨 Claude Code 原生日志排查。

建议：

- P2 增加可选 `include_tool_calls` 或 `tool_call_summary`。
- 默认只记录工具名、目标路径、命令类别和状态，不记录敏感内容。
- 与 run log retention policy 绑定，避免审计日志无限增长。

## 5. 易用性审查

### U1. 默认路径仍有过多内部概念

即使默认只暴露 5 个工具，返回值中仍有 job、run、session、worktree、lifecycle、result_status、server_observed、next_actions 等概念。技术用户能理解，普通用户需要更高层抽象。

建议：

- `claude_task` 顶层增加 `user_summary`、`primary_next_step`、`safe_commands`。
- 在普通路径隐藏 `run_id` / `job_id`，除非需要恢复。
- README 增加“只记住三件事”：setup、task、preview/apply。

### U2. `claude_result` 对 read-only 也提示 preview，容易误导

`claude_result` 根据 success/partial 判断 `next_step`，成功时统一提示 `Preview the worktree changes with claude_apply preview=true.`。对于 query/review 结果，这个提示不准确。

证据：

- `src/server.ts:688-701` `claude_result` interaction 没区分 result 类型是否有 worktree。

建议：

- 只有 source 是 implement/apply-blocked 且有 `worktree_path` 时提示 preview。
- read/review 提示“review answer/findings, no apply needed”。

### U3. advanced tools 配置示例可能让用户丢掉默认工具

README 的 Advanced / Debug 示例给出 `enabled_tools = ["claude_status", ...]`，里面不包含默认 5 工具。如果用户直接复制，可能只启用高级工具，反而丢掉主路径。

建议：

- 示例改为“默认 5 + 需要的高级工具”。
- 或提供 CLI：`codex-claude setup --enable-advanced claude_workspace_status,claude_runs`。

### U4. `files` 语义和 warning 文案仍有残留不一致

项目已经把 `claude_task.files` 定义为 deprecated context，不是 apply scope。FUNC-001 之后 `claude_task.allowed_files` 已存在，但 warning、tool schema 和插件 skill 文档仍有残留不一致：高层 warning 未明确字段归属，`claude_implement.files` 的 schema 描述仍像 context 文件，技能文档仍暗示必须降级到 Advanced 工具才能做严格文件范围。

证据：

- `src/claude-cli.ts` warning 文案。
- `src/server.ts` tool schema 中 `claude_task.files` 与 `claude_implement.files` 描述。
- `plugins/codex-claude-delegate/skills/*.md` 的范围控制指引。

建议：

- `claude_task.files` warning 明确推荐 `claude_task.allowed_files`，并把 `claude_implement.files` 标为 Advanced 等价路径。
- `claude_implement.files` tool schema 明确为 hard file modification scope，而不是 context。
- 插件 skill 文档同步高层/高级两条路径。

### U5. `setup --project --allow-root` 语义可能混淆

`setupWrite({ isProject: true })` 会把 MCP 配置写到项目 `.codex/config.toml`，但 `--allow-root` 调用的是 `configureCodexAllowRoot()`，该函数写全局 Codex config。当前 CLI 已拒绝 `--project --allow-root` 组合，但错误和帮助文案仍需明确两者的写入范围和正确的两步配置流程。

证据：

- `src/codex-config.ts:526-556` project/global MCP config 写入。
- `src/codex-config.ts:559-566` allow root 调用全局配置 helper。
- `src/codex-config.ts:418-473` `configureCodexAllowRoot()` 使用全局 `codexConfigPath()`。

建议：

- `setup --project --allow-root` 输出明确说明 allow root 写入位置。
- 或支持 project-level allow root 写入。
- doctor 显示 allow roots 来源：global / project / MCP env / shell env。

### U6. `claude_setup configure_allow_root` 的下一步提示前后不一致

当 cwd 不在 allow roots 且 `configure_allow_root` 可用时，一个 reason 说“retry setup in the same MCP process”，interaction 却说“restart Codex”。用户不知道是否必须重启。

证据：

- `src/server.ts:642-656` 两处文案不一致。

建议：

- 如果当前进程已更新 `process.env.CODEX_CLAUDE_ALLOW_ROOTS`，提示“本次可立即重试；重启后配置永久生效”。

### U7. 输出语言和文档语言不统一

README、安全文档大量中文，但 MCP interaction 和错误下一步大多英文。对中文用户，尤其是失败恢复场景，认知成本高。

建议：

- 先不做完整 i18n，增加 `language?: "zh" | "en"` 或根据 README/AGENTS 语言默认中文。
- 错误 payload 保持字段英文，`interaction.next_step` 可本地化。

## 6. 工程维护性审查

### M1. `claude-cli.ts` 已拆分但仍偏大

从历史记录看，`claude-cli.ts` 已从 3000+ 行降到约 2137 行，并拆出 `run-logs.ts`、`workflow-results.ts`、`review-gate.ts`、`worktree-observer.ts` 等模块。但它仍包含 task routing、background wrappers、cleanup artifact、Claude query/review/implement、apply、cleanup 等多类职责。

建议：

- 下一轮优先拆 `apply-service.ts` 和 `cleanup-service.ts`，因为它们风险最高、测试边界清晰。
- 再拆 `task-router.ts`，集中处理 mode inference、wait metadata、dedupe。

### M2. 手写 TOML 解析长期风险仍在

`codex-config.ts` 用正则读写 TOML table、array、number。当前测试覆盖不少常见路径，但 TOML 允许注释、多行数组、不同缩进、转义、嵌套表，长期容易出边界 bug。

证据：

- `src/codex-config.ts:45-113` 手写 table/key/array/number parser。

建议：

- 引入成熟 TOML parser/writer，或把 config 写入限制为本工具管理的 section，并对复杂手写 config fail closed。
- 如果不引依赖，至少补多行数组、注释、同名 key、Windows path、转义字符串测试。
- `configure_allow_root` 写全局 config 时加文件锁或采用原子 write-then-rename，避免并发 setup 截断或覆盖用户配置。

### M3. run/job/session state 分散，用户难以维护

运行状态分散在 `.codex-claude-delegate/jobs`、`.codex-claude-delegate/runs`、session store、`.claude/worktrees`、review gate state。已有 cleanup helper，但用户主路径只看到 `claude_cleanup`。

建议：

- `codex-claude doctor` 增加“状态体积”统计。
- `codex-claude cleanup --all --dry-run` 同时预览 jobs、runs、sessions、worktrees。

### M4. 路线图缺少依赖关系、工作量和回滚策略

原路线图按 P0/P1/P2 排序已经可读，但对实际执行仍偏粗。尤其 `SEC-001` 事务型 apply 与 `FUNC-002` 完整 preview patch 共用 apply/diff 核心路径，如果分开设计，容易返工。

建议：

- 每个 issue 标注工作量 S/M/L 和依赖项。
- `SEC-001` 与 `FUNC-002` 合并设计，分阶段落地。
- `SEC-004` 与 `SEC-005` 作为“安全策略 v2”统一设计配置形态。
- `FUNC-001` 与 `FUNC-003` 共享 `claude_task` 输入扩展，先定 schema 兼容策略。
- 对事务型 apply 这类核心行为变更，提供短期 feature flag 或 legacy escape hatch。

### M5. P0/P1 安全项需要更具体的测试计划

当前 issue 清单有正向/负向验收，但测试层次还不够细。安全类改动应明确单元测试、集成测试和故障注入。

建议：

- `SEC-001`：单元测试覆盖 backup/rollback，集成测试覆盖写入中途失败、权限不足、回滚失败。
- `SEC-002`：多进程/长运行测试覆盖 active lock、stale lock、job-runner 重启。
- `SEC-003`：状态机测试覆盖 pending 设置、匹配 review 清除、无关 review 不清除、apply 后重新 pending。
- `SEC-005`：对抗性测试覆盖 Claude 尝试读取 deny 文件时被拒绝。

### M6. 成功度量需要产品化

如果要判断这些修复是否真的改善体验，仅靠“实现完成”不够。需要少量低成本指标帮助后续决策。

建议：

- `SEC-001`：故障注入下主工作区保持 apply 前状态的比例目标为 100%。
- `UX-001`：中文任务误路由率目标低于 5%。
- `FUNC-002`：记录用户 preview 后取消 apply 的比例，作为 preview 是否真正可审查的间接信号。
- `FUNC-003`：区分 Claude 自报 tests 与 server verified tests 的通过率。

## 7. 竞品和参考项目对比

以下竞品/参考均按公开官方文档做能力对比，不代表它们都与本项目直接同类。

### 7.1 Cursor Cloud Agents

官方文档要点：

- Cloud Agents 在隔离云环境运行，而不是本机。
- 可并行运行多个 agents。
- 会 clone GitHub/GitLab repo，在独立 branch 工作并 push 交付。
- 支持 MCP、hooks。
- 支持 artifacts，包括 screenshots、videos、logs；也支持 remote desktop control。
- Setup 支持 isolated Ubuntu machines、Dockerfile、environment.json、install/update/start commands、multi-repo environments、secrets。

参考：

- [Cursor Cloud Agents overview](https://cursor.com/docs/cloud-agent)
- [Cursor Cloud Agents setup](https://cursor.com/docs/cloud-agent/setup)

对本项目启发：

- 本项目无需马上做云端，但可以补齐“环境定义 + artifacts + branch export”。
- `worktree` 是本地隔离，下一步应做到“本地也有清晰 artifacts 和 verification trail”。

### 7.2 GitHub Copilot cloud agent

官方文档要点：

- 可 research repository、create implementation plan、make code changes on branch。
- 用户可 review diff、iterate、ready 后 create pull request。
- 工作环境是 GitHub Actions powered ephemeral development environment。
- GitHub 上的分支、commit、logs 提供透明度和协作。
- 支持 custom agents、usage metrics、第三方集成。

参考：

- [GitHub Copilot cloud agent overview](https://docs.github.com/en/copilot/using-github-copilot/coding-agent/about-assigning-tasks-to-copilot)

对本项目启发：

- 本项目最缺的是 branch/PR 交付和团队可见的 audit trail。
- “先 plan、再 code、再 PR”的流程可以映射为：`claude_task mode=read/review` 产计划，`claude_task mode=write` 执行，`claude_apply preview` 审查，`export branch/PR` 交付。

### 7.3 OpenAI Codex CLI / Codex

官方文档要点：

- Codex CLI 提供 approval modes，例如 `untrusted`、`on-request`、`never`。
- 提供 sandbox policy：`read-only`、`workspace-write`、`danger-full-access`。
- `--dangerously-bypass-approvals-and-sandbox` 只建议在外部加固环境使用。
- Codex 生态包含 AGENTS.md、MCP、hooks、skills、subagents、cloud tasks 等能力。

参考：

- [Codex CLI command line options](https://developers.openai.com/codex/cli/reference)
- [Codex CLI docs](https://developers.openai.com/codex/cli)

对本项目启发：

- 本项目作为 Codex 的 MCP 工具，应尽量把“风险等级、是否会写入、是否需要确认、是否外部推理”结构化暴露给 Codex。
- 未来可以提供 Codex plugin/skill 层的 “safe workflow command”，减少用户直接碰 tool matrix。

### 7.4 Claude Code 原生能力

官方文档要点：

- Claude Code settings 支持 permission allow/ask/deny 规则。
- 支持 `Read(./.env)`、`Read(./secrets/**)` 等敏感文件 deny。
- 支持 sandbox filesystem/network 规则。
- 支持 hooks、worktree settings、managed settings、plugin settings。

参考：

- [Claude Code hooks](https://docs.anthropic.com/en/docs/claude-code/hooks)
- [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings)

对本项目启发：

- 本项目已经利用了 `--allowedTools` / `--disallowedTools`，但还没有充分利用 file deny、sandbox、managed settings。
- 可以增加“生成 Claude Code policy file”的 setup 选项，而不是只在命令行上传 permissions。

### 7.5 Aider

官方文档要点：

- Aider 是本地终端里的 AI pair programming 工具，围绕 git repo 工作。
- 用户可以通过命令行指定要编辑的文件，也可以在会话中 `/add` 文件。
- Aider 支持多种 edit formats，包括 whole、diff、diff-fenced、udiff；其中 diff/search-replace 和 udiff 都强调可应用的文本补丁结构。
- 支持 lint/test 工作流，能在编辑后运行 lint/test 并把结果反馈给模型。

参考：

- [Aider edit formats](https://aider.chat/docs/more/edit-formats.html)
- [Aider usage](https://aider.chat/docs/usage.html)
- [Aider linting and testing](https://aider.chat/docs/usage/lint-test.html)

对本项目启发：

- `claude_apply preview` 可以借鉴 Aider 对 diff/udiff 的重视：用户需要看到可审查、可 hash、可复现的 patch，而不只是文件列表。
- 高层 scope 可以借鉴“会话中明确加入文件”的心智模型：哪些文件可读、哪些文件可改，应在输出中非常明确。

### 7.6 Cline

官方文档要点：

- Cline 是 VS Code 内的 agent 工具，围绕工具调用、MCP server、用户授权和 IDE 上下文工作。
- Cline 的 MCP Marketplace 提供 MCP server 发现、安装和配置入口。
- 其功能文档强调默认会在调用工具前请求用户权限，并支持 auto approve 配置。

参考：

- [Cline MCP Marketplace](https://docs.cline.bot/mcp/mcp-marketplace)
- [Cline features / auto approve](https://docs.cline.bot/features)

对本项目启发：

- 本项目作为 MCP server，应把每次 delegate 的风险等级、工具权限、写入范围、确认条件展示得更像“授权决策”，而不是只像后台任务状态。
- setup/doctor 可以学习 Cline 的 marketplace 心智，把 MCP server、权限、依赖状态用更用户化的方式展示。

### 7.7 Devin

官方文档要点：

- Devin 定位为 autonomous AI software engineer，可以 write、run、test code。
- 典型任务包括 Linear/Jira tickets、features、bug repro/fix、internal tools。
- 产品预期是完整工程循环，而不只是代码修改。

参考：

- [Devin docs](https://docs.devin.ai/)

对本项目启发：

- 本项目无需复制 Devin 的云端自治形态，但应补齐“任务 -> 实现 -> 验证 -> 交付 -> 可追溯记录”的闭环。
- `server_verified`、artifacts、branch/PR export 和 run replay 是追赶完整工程循环的关键。

## 8. 竞品差距矩阵

| 能力 | 本项目当前 | Cursor Cloud Agents | GitHub Copilot cloud agent | Codex CLI/Cloud | 建议优先级 |
|---|---|---|---|---|---|
| 本地委托到另一个 agent | 强 | 非核心 | 非核心 | 可用 MCP/subagents | 保持 |
| 本地 worktree 隔离 | 有 | 云端 VM/branch | GitHub Actions branch | sandbox/worktrees | 保持并加 lock |
| 强沙箱 | 无，纵深防御 | 云端隔离 | GitHub Actions ephemeral | sandbox policy | P1 |
| apply 前确认 | 中，强制确认但缺完整 patch | PR/diff review | PR/diff review | approval modes | P0 |
| 事务型 apply | 弱 | branch/PR 天然可回退 | branch/PR 天然可回退 | patch/apply workflow | P0 |
| 完整 diff preview | 弱 | PR/artifacts | PR diff/logs | diff/review | P0 |
| active job/worktree lifecycle | 偏弱，记录多于保护 | Agent run lifecycle | GitHub run lifecycle | task/worktree lifecycle | P0 |
| 环境 setup/cache | 弱 | 强 | GitHub Actions workflow | Cloud environments | P1 |
| secrets 管理 | 弱，主要剥离 env | 强 | GitHub secrets/actions | platform settings | P1 |
| artifacts | 弱 | 强 | logs/checks/PR | traces/logs | P1 |
| PR 交付 | 无 | 有 | 有 | Cloud tasks | P2 |
| 多仓 | 无 | 有 | 部分依赖 GitHub workflow | workspace/add-dir | P2 |
| 中文体验 | 弱 | 未评估 | 未评估 | 取决于客户端 | P0/P1 |
| patch/edit 原子性 | 弱 | PR 可回退 | PR 可回退 | patch/review | P0 |
| MCP 工具授权体验 | 中 | 支持 MCP/hooks | 依赖 GitHub 权限 | MCP/approval modes | P1 |
| 成本/资源上限 | 单任务有上限，并发弱 | 平台侧管理 | GitHub/组织侧管理 | 取决于环境 | P1 |

## 9. 优先级路线图

### P0：先修安全和正确性

1. **事务型 apply**
   - 状态：已完成，提交 `dbd12c0 fix: make claude_apply transactional`。
   - 修复方式：引入事务层，apply 前备份目标文件；任一写入/删除失败时回滚；回滚失败返回 `dirty_recovery_needed`；server interaction 不再把 partial/conflicted apply 显示为成功。
   - 已验证：`npm run typecheck`；`npx vitest run tests/transaction.test.ts tests/claude-cli.test.ts tests/server.test.ts`。
   - 正向验收：所有文件可应用时，主工作区完整更新。
   - 负向验收：任一文件写入失败时，主工作区回滚到 apply 前状态，返回 `error`。
   - 回滚失败验收：明确返回 `dirty_recovery_needed`，列出已写入、已回滚、回滚失败的文件。
   - 禁止行为：有 conflicts 时返回“applied success”。
   - 测试要求：覆盖 copy 失败、delete 失败、权限不足、回滚失败、并发修改。

2. **active implement worktree lock**
   - 状态：已完成，提交 `b8d75dd fix: lock active implement worktrees`。
   - 修复方式：implement 生命周期持有 `worktree:<name>` lock；background job 早写 `worktree_name`；cleanup 查询 active implement job 并跳过运行中的 worktree；busy 文案覆盖 implement/apply/cleanup。
   - 已验证：`npm run typecheck`；`npx vitest run tests/lock.test.ts tests/jobs.test.ts tests/background-jobs.test.ts tests/claude-cli.test.ts`；`npm test`。
   - 正向验收：implement job 运行时，cleanup/apply 对同一 worktree 返回 busy 或 skipped。
   - 负向验收：cleanup `dry_run=false older_than_hours=0` 不会删除 active job worktree。
   - 禁止行为：`git worktree remove --force` 删除正在运行的 delegated worktree。
   - 测试要求：覆盖 active job、多进程竞态、stale lock、job-runner 重启。

3. **禁止 nested delegated worktree**
   - 状态：已完成，提交 `4e173a3 fix: reject nested delegated write worktrees`。
   - 修复方式：新增路径段级 `isDelegatedWorktreePath`；`claude_implement`、`claude_task(mode=write)`、`resume_latest`、`constraints` 和 auto inferred write 均在 nested cwd 内 fail closed；read/review 放行。
   - 已验证：`npm run typecheck`；`npx vitest run tests/guard.test.ts tests/server.test.ts`；`npm test` 中 doctor smoke 偶发失败后，精确重跑该用例通过。
   - 正向验收：主 repo cwd 下的 write task 正常创建一级 delegated worktree。
   - 负向验收：`cwd` 已位于 `.claude/worktrees/codex-delegated-*` 内时，`claude_task(mode=write)` 和 `claude_implement` 返回明确错误。
   - 禁止行为：在 delegated worktree 内继续创建 `.claude/worktrees/codex-delegated-*`。
   - 测试要求：覆盖路径段匹配、误杀边界、symlink 指向 delegated worktree。

4. **implement resume_latest 失效回退**
   - 状态：已完成，提交 `1a4d534 fix: retry expired implement resume sessions`。
   - 修复方式：先给 `resolveLatestImplementSession` 增加 session store 时效过滤，再做 `No conversation found` 的同 worktree bounded fresh retry；这样 fallback 保持异常恢复语义，而不是被过旧 session 频繁触发成常规路径。
   - 已验证：`npm run typecheck`；`npx vitest run tests/claude-cli.test.ts`；`npx vitest run tests/session.test.ts tests/claude-cli.test.ts`。
   - 正向验收：近期有效 session 可正常 resume。
   - 负向验收：过旧 session 不会被选中；Claude CLI 返回 session not found 时，MCP 标记 expired，并在同一 worktree 内最多 retry 一次 fresh implement。
   - 禁止行为：session 失效后无限 retry，或新开第二个 worktree 造成状态分叉。
   - 测试要求：覆盖 session 时效窗口、retry 成功、retry 失败、warning 文案、dirty snapshot 保留。

5. **完整 preview patch**
   - 状态：已完成，提交 `be94110 feat: add patch output to apply preview`。
   - 修复方式：`claude_apply preview=true include_patch=true` 返回 scoped binary patch、完整 patch SHA-256、字节数和截断元数据；大 patch 持久化到 `.claude/patches/<runId>.patch`；untracked 文件用 `untracked_not_in_patch=true` 明确标记第一阶段能力边界。
   - 已验证：`npm run typecheck`；`npx vitest run tests/schema.test.ts tests/server.test.ts tests/claude-cli.test.ts`；`npm run build && npm test`（doctor smoke flaky 单独重跑通过）；`npm run audit:docs`。
   - 正向验收：`claude_apply preview=true include_patch=true` 返回 patch、hash、truncation metadata。
   - 负向验收：大 diff 被截断时仍返回 `patch_path` 或可复现 diff 指纹。
   - 禁止行为：只给文件列表和 stat 却要求用户确认 apply。
   - 依赖关系：与事务型 apply 共用 diff/apply 核心设计，应合并设计、分阶段实现。

6. **review gate 与 write run 绑定**
   - 状态：已完成，提交 `94aedc6 fix: bind review gate to reviewed runs`。
   - 修复方式：pending state 记录 write/apply run metadata；review 必须显式带匹配的 `reviewed_run_id`，以及可选 worktree path 同时匹配，才清除 pending；后台 review 排队不再清 pending。
   - 已验证：`npm run typecheck`；`npx vitest run tests/review-gate.test.ts tests/schema.test.ts tests/server.test.ts tests/claude-cli.test.ts`；`npm run build && npm test`（doctor smoke flaky 单独重跑通过）；`npm run audit:docs`。
   - 正向验收：review 同一个 write run/diff 后清 pending。
   - 负向验收：无关 review 不清 pending。
   - apply 后验收：主工作区发生 apply 后重新置 pending，直到 post-apply review 或验证通过。
   - 禁止行为：只要有任何 review 成功就清 pending。
   - 测试要求：状态机覆盖 pending set/clear、无关 review、apply 后 pending。

7. **中文/多语言 mode inference**
   - 状态：已完成，提交 `b6a0a2b fix: infer chinese task modes`。
   - 修复方式：`claude_task(mode=auto)` 统一走 `inferClaudeTaskMode`，新增中文/混合语言 write/review/read hints；diff 优先 review，constraints 优先 write，中文 query prefix（如“解释如何修复 bug”）优先 read；结果返回可选 `mode_inference`，包含 `requested_mode`、`delegated_mode`、`reason`、`confidence`、`matched_hints`；server nested write guard 复用同一推断入口，避免中文写入绕过保护。
   - 已验证：`npm run typecheck`；`npx vitest run tests/claude-cli.test.ts tests/server.test.ts tests/schema.test.ts`；`npm run audit:docs`；`npm run build && npm test`（doctor smoke flaky 失败，精确用例单独重跑通过）。
   - 正向验收：“修复测试失败”推断 write，“审查安全风险”推断 review，“解释架构”推断 read。
   - 负向验收：“解释如何修复 bug”推断 read，“修复这个 bug 然后解释一下”推断 write；nested delegated worktree 内中文写入 auto task 被拒绝。
   - 禁止行为：中文写入任务 silent fallback 到 read。

### P1：补齐产品化能力

6. **高层硬 scope**
   - 状态：已完成，提交 `0d25456 feat: scope high-level claude tasks`。
   - 修复方式：`claude_task` 新增 `allowed_files` 和 `max_changed_files`；write 路径把 `allowed_files` 透传到底层 `claude_implement.files`，复用 existing dirty preflight、observe scope、preview/apply scope refusal；`max_changed_files` 透传到 resource limits；deprecated `files` 继续只作为 instruction/context；implement prompt 将 scoped `files` 明确标为 `Allowed Files`。
   - 已验证：`npm run typecheck`；`npx vitest run tests/schema.test.ts tests/server.test.ts tests/claude-cli.test.ts`；`npm run audit:docs`；`npm run build && npm test`（doctor smoke flaky 失败，精确用例单独重跑通过）。
   - 正向验收：`claude_task.allowed_files` 限制写入和 apply。
   - 负向验收：Claude 修改 allowed_files 外文件时 preview/apply 拒绝。
   - 禁止行为：把 `files` 继续混用为 context 和 scope。

7. **server crash/orphan recovery**
   - 状态：已完成，提交 `b00ce5e fix: recover crashed background jobs`。
   - 修复方式：新增 `crashed` terminal job 状态；server startup best-effort 扫描 active jobs；dead/missing PID 且超过 grace/stale 阈值时标记 crashed；保留 worktree/run/job 信息；workspace status 展示 crashed jobs 和 inspect/apply preview next actions。
   - 已验证：`npm run typecheck`；目标 vitest；`npm run audit:docs`；`git diff --check`；`npm run build && npm test`（doctor smoke flaky，精确重跑通过）。
   - 启动时扫描 running jobs、PID、heartbeat、worktree。
   - stale/crashed job 标记为 `crashed`，保留 inspect/apply/cleanup 路径。
   - `claude_workspace_status` 展示 crashed jobs 和下一步。

8. **implement 并发保护**
   - 默认同一 repo 同时只允许 1 个 implement。
   - 返回 busy/queued/reused 的明确决策。
   - doctor 展示 active Claude 进程数。
   - 状态：已完成。采用 busy/reused（dedupe）而非隐藏排队；workspace_status/doctor 展示 active background runner PID 计数。

9. **严格 env passthrough**
   - 默认只保留最小 env。
   - passthrough 必须显式配置。
   - doctor 展示被剥离/保留的类别，不展示值。
   - 状态：已完成。严格 allowlist + `CODEX_CLAUDE_ENV_PASSTHROUGH` 显式 opt-in；doctor/README/SECURITY 已同步。

10. **敏感文件 deny policy**
   - 默认 deny `.env*`、`secrets/**`、key/cert 文件。
   - 提供 strict/off。
   - adversarial tests 覆盖。
   - 状态：已完成。默认/strict/off 已覆盖四个 Claude 入口；默认阻断 `.env`/`.env.*`/`secrets/**`，strict 扩展到常见密钥和凭据文件；后台任务指纹归一默认策略。

11. **server-side verification**
   - 支持 `verification_commands`。
   - 输出 `server_verified`，不要只信 Claude 自报。
   - 状态：已完成 server-side verification。`verification_commands` 在 delegated worktree 中受控运行，失败降级为 `partial`；artifacts 汇总仍属 P2。

12. **状态维护命令**
   - `codex-claude cleanup-artifacts --dry-run` 预览 terminal job records 和旧 run logs。
   - 状态：已完成。提交 `3ab93fb feat: expose artifact cleanup cli`；CLI 默认 dry-run，`--execute` 才删除已结束 job records 和匹配保留窗口的 run logs。delegated worktree 继续使用 `claude_cleanup`，不由该命令删除；sessions/worktrees 保留策略归入后续状态维护项。

13. **文档和 setup 修正**
   - Advanced tools 示例包含默认 5 工具。
   - 状态：部分完成。UX-002 已完成，提交 `2751c50`；README 高级 `enabled_tools` 示例已改为“默认 5 + 需要的高级工具”，并新增 doc audit 防止高级示例遗漏默认工具。
   - `setup --project --allow-root` 明确写入位置。
   - 修正 `files` warning。

14. **nested apply path 和 permission_denials 可见性**
   - `claude_apply` 对多段 `.claude/worktrees/` 返回 nested worktree 不支持的清晰错误。
   - implement result 显式展示 Claude `permission_denials`，提示用户本地重跑验证。
   - 不做跨 workspace metadata 查找；不在 status/setup 中默认执行 Bash smoke test。

### P2：追赶竞品体验

14. **branch/PR export**
   - 从 worktree 创建 branch，生成 commit，支持 draft PR。
   - 默认不 push，必须确认。

15. **环境定义**
   - `.codex-claude-delegate/environment.json`。
   - 支持 install/test/start/symlink/sparse paths。

16. **artifacts 和可视化状态**
   - 保存测试日志、截图、coverage、trace。
   - `claude_workspace_status` 展示 artifact links。

17. **multi-repo read/review**
   - 先只读支持多个 workspace roots。
   - write 继续单 repo，避免 apply 复杂度爆炸。

18. **`.gitignore` 和 submodule 策略**
   - preview 标记 ignored 文件和匹配规则。
   - doctor 检测 `.gitmodules`，write/apply 默认警告或拒绝 submodule gitlink 变更。

### P3：长期机会

19. **managed policy pack**
   - 团队可定义命令、文件、网络、env、review gate 策略。

20. **云端/远程 runner**
   - 本地 MCP 只做 control plane，执行放到 hardened VM/container。

21. **度量和回放**
   - 记录任务耗时、成功率、apply 拒绝原因、测试通过率。
   - 支持导出匿名 metrics。

### 依赖关系和工作量建议

| 组 | 相关 issue | 依赖/说明 | 估算 |
|---|---|---|---|
| apply core | SEC-001, FUNC-002 | 先统一 diff/patch/backup/rollback 模型，再分 PR 实现 | L |
| lifecycle core | SEC-002, SEC-006, SEC-007 | worktree lock、orphan recovery、并发保护共享 job 状态判断 | L |
| security policy v2 | SEC-004, SEC-005 | env allowlist 与 sensitive file deny 共用 policy 配置 | M |
| high-level API | FUNC-001, FUNC-003 | `claude_task` schema 扩展需一次性设计兼容策略 | M |
| P2 product loop | FUNC-009, FUNC-010, UX-005, OBS-001 | artifacts、multi-root、dedup 可见性和 audit trail 共同补齐可追溯体验 | M |
| docs/ux cleanup | UX-002, UX-003, UX-004 | 可独立做，适合作为低风险先手 | S |

## 10. 具体可建 issue 清单

| ID | 标题 | 类型 | 优先级 | 估算 | 状态 / 修复方式 |
|---|---|---|---|---|---|
| REL-001 | Add release asset consistency gate before npm publish | release/safety | P0 | M | 已完成：`490a9f6`；`prepublishOnly` 串入 `audit:docs` 和 `check:release`，新增 `npm pack --json --dry-run` 发布资产闸门，校验必需/禁止 tarball 文件与 plugin/package 版本一致；同时移除 docs audit 中已过期、未跟踪的单文件根 |
| REL-002 | Add install-from-tarball smoke test before npm publish | release/safety | P0 | M | 已完成：`ecbe5dd`；新增 `check-release-install-smoke.mjs`，在隔离临时目录执行 `npm pack` + `npm install` 并验证已安装 bin `--version` 输出和 `dist/cli.js`、`dist/server.js` 存在；`prepublishOnly` 在 `check:release` 之后追加 `check:release:install`；支持 `CHECK_RELEASE_TARBALL_FILE`、`CHECK_RELEASE_INSTALL_DIR`、`CHECK_RELEASE_REPO_ROOT` 测试钩子 |
| APPLY-TOCTOU-001 | Bind non-preview apply to the exact previewed worktree content | security | P0 | M | 已完成：`a610f95`；`claude_apply preview=true` 返回内容级 `preview_token`，非预览 apply 必须传入匹配 token；token 覆盖 planned changes 与将复制的 tracked/untracked 文件内容，预览后内容变化会 fail closed 且不修改主工作区 |
| APPLY-MATRIX-001 | Add edge-state matrix for claude_apply safety boundaries | security/test | P0 | M | 已完成：`5e3074f`；新增 symlink/chmod/type-change apply 边界测试矩阵，symlink 写入和 chmod/mode change fail-closed，symlink-to-directory 不再展开成普通文件，普通 regular file apply + preview_token 回归保持通过 |
| APPLY-MATRIX-002 | Add main workspace collision matrix for claude_apply | security/test | P1 | M/L | 已完成：`10fcc88`；`preview_token` 升级为绑定 worktree 内容与主工作区目标状态，预览后目标文件内容/存在性变化会 fail closed；preview/apply 主工作区 preflight 新增 dirty、untracked、gitignored、目录/文件冲突、父路径为文件、大小写兄弟冲突、rename/copy/delete 目标碰撞矩阵测试；回滚失败测试覆盖 `rollback_restore_failed` recovery |
| VERIFY-ENV-001 | Add non-escalating environment config phase 2 | security/verification | P1 | M | 已完成：`6826085`；`.codex-claude-delegate/environment.json` 新增 Phase 2 `verification.allowedScripts`/`timeoutSec`、`artifacts.retentionDays`、`environment.passthrough`；验证配置只做限制/限时，artifacts/env 字段仅诊断；敏感 env 名称、危险脚本名、shell-ish token 和越界 timeout/retention 均 fail closed；doctor/workspace_status 暴露安全摘要 |
| ARTIFACT-INDEX-001 | Add machine-readable artifact index | observability/recovery | P1 | M | 已完成：`2c773ce`；新增 `.codex-claude-delegate/artifacts/artifacts.json` 元数据索引，记录 patch 与 verification stdout/stderr tail 的路径、SHA-256、字节数、时间戳、producer、sensitivity；`claude_result`/`claude_workspace_status` 仅暴露聚合摘要；cleanup-artifacts 集成过期索引 prune，删除范围限制在 `.codex-claude-delegate/artifacts/` 与 `.codex-claude-delegate/apply-backups/`；索引不嵌入 patch/stdout/stderr/command 内容 |
| SEC-001 | Make claude_apply transactional with rollback on partial failure | bug/security | P0 | L | 已完成：`dbd12c0`；事务备份、失败回滚、dirty recovery |
| SEC-002 | Hold worktree lock during implement and skip active worktrees in cleanup | bug/security | P0 | M | 已完成：`b8d75dd`；implement lock、active cleanup skip |
| SEC-008 | Reject nested delegated write worktrees | bug/security | P0 | S | 已完成：`4e173a3`；nested write guard、read/review 放行 |
| SEC-009 | Handle expired implement resume_latest with bounded fresh retry | bug/ux | P0 | M | 已完成：`1a4d534`；session store 时效过滤、同 worktree bounded fresh retry |
| FUNC-002 | Add patch output to claude_apply preview | feature/security | P0 | M | 已完成：`be94110`；include_patch、patch hash/truncation、persistent patch_path、untracked_not_in_patch |
| SEC-003 | Bind review gate pending state to write run/job fingerprint | security/ux | P0 | M | 已完成：`94aedc6`；pending run metadata、显式 reviewed_run_id 匹配、后台 review 不再排队清除 |
| UX-001 | Add Chinese keywords and confidence metadata to claude_task mode inference | bug/ux | P0 | S | 已完成：`b6a0a2b`；中文/混合语言 hints、query prefix override、`mode_inference` metadata、nested guard 复用推断 |
| FUNC-001 | Add claude_task.allowed_files and max_changed_files passthrough | feature/security | P1 | M | 已完成：`0d25456`；`allowed_files` 硬 scope 透传、`max_changed_files` 透传、deprecated `files` 保持 context |
| SEC-006 | Recover crashed/orphaned background jobs on server startup | bug/security | P1 | M | 已完成：`b00ce5e`；`crashed` terminal 状态、startup recovery、workspace crashed visibility、inspect/apply preview next actions |
| SEC-007 | Add max_concurrent_implements and active Claude process visibility | security/cost | P1 | M | 已完成：`03c56fc`；同 repo implement cap=1、busy/dedupe 结构化结果、workspace_status/doctor active runner PID 可见性 |
| SEC-004 | Add strict env allowlist and explicit passthrough config | security | P1 | M | 已完成：`9e3a629`；严格默认 allowlist、显式 passthrough、敏感 passthrough 拦截、doctor/env docs 同步 |
| SEC-005 | Add default sensitive file deny policy for Claude Read/Grep/Glob | security | P1 | M | 已完成：`8c9c574`；`sensitive_file_policy` default/strict/off、Read/Grep/Glob/Bash 读取 deny、默认策略指纹归一、README/SECURITY 同步 |
| FUNC-003 | Add server-side verification_commands | feature | P1 | M | 已完成：`f5b2a17`；`verification_commands`、`server_verified`、无 shell allowlist 执行、失败降级 partial、fingerprint 纳入验证命令 |
| FUNC-004 | Expose cleanupDelegateArtifacts through CLI | feature | P1 | S | 已完成：`3ab93fb`；`cleanup-artifacts` 默认 dry-run，支持 `--execute`、`--json`、`--cwd`、`--older-than-hours`、`--limit`；范围限定 terminal jobs/run logs，不删除 worktree |
| UX-002 | Fix README advanced tools enabled_tools example | docs | P1 | S | 已完成：`2751c50`；README 高级工具示例保留默认 5 工具再追加高级工具，`audit-docs` 新增回归检查 |
| UX-003 | Fix files deprecation warning wording | docs/ux | P1 | S | 已完成：`39f5810`；弃用 warning 明确推荐 `claude_task.allowed_files`，`claude_implement.files` schema 改为硬范围描述，插件 skills 同步高层/高级两条范围控制路径 |
| UX-004 | Clarify project/global behavior for setup --project --allow-root | docs/cli | P1 | S | 已完成：`666611d`；README 和 CLI usage/error 明确 `--project` 写项目 `.codex/config.toml`、`--allow-root` 写全局 Codex allow-root 配置，并提示先 global allow-root 后 project MCP config 的两步流程 |
| UX-006 | Return clear errors for nested apply paths and surface permission_denials | ux/safety | P1 | S | 已完成：`11ddd68`；nested apply path 清晰错误、`permission_denials` warning、本地重跑验证提示 |
| FUNC-005 | Export delegated worktree to branch/draft PR | feature | P2 | M | 已完成：`c700279`；新增 `claude_export`，可将 delegated worktree 的 observed changes 通过临时 index/`commit-tree` 导出为本地 branch，不 checkout/污染主工作区；拒绝缺 metadata、scope/resource limit exceeded、非法/冲突 branch，暂不做 push/draft PR |
| FUNC-006 | Add local environment config for install/test/start/symlink/sparse paths | feature | P2 | L | 已完成：`4822da9`；新增 `.codex-claude-delegate/environment.json` Phase 1 诊断，读取/校验 `install`、`test`、`start`、`symlink_directories`、`sparse_paths` 并在 doctor/workspace_status 暴露安全摘要；默认不执行命令、不创建 symlink、不做 sparse checkout |
| FUNC-007 | Mark git-ignored files in apply preview | feature/ux | P2 | S | 已完成：`85b9a4e`；`claude_apply preview=true` 新增 `ignored_changes`，扫描 delegated worktree 中被 gitignore 隐藏的未跟踪文件并返回匹配规则/来源/行号；不改变 `planned_changes` 和非预览 apply 行为 |
| FUNC-008 | Detect submodules and fail closed for submodule write/apply | feature/safety | P2 | S | 已完成：`3407da9`；`claude_apply` 从 delegated worktree 的 HEAD/base/index 检测 gitlink/submodule 路径，submodule 本身或其内部路径一律进入现有 apply refused 冲突路径；普通文件在含 submodule 仓库中仍可正常 preview/apply |
| FUNC-009 | Save and expose test artifacts via claude_workspace_status | feature/observability | P2 | M | 已完成：`2c4d0f0`；从已保存的 run log `server_verified` 派生小型 verification artifact 摘要，在 `RunLogEntrySummary.server_verified` 与 `claude_workspace_status.recent_artifacts` 暴露状态/命令计数，不新增 artifact 存储、不暴露 stdout/stderr tail |
| FUNC-010 | Support multi-root read/review with independent allow/scope per root | feature | P2 | L | 已完成：`14cbd32`；新增 `context_roots` 只读多根上下文，支持 `claude_task` read/review、`claude_query`、`claude_review`，写入/推断写入模式 fail closed；每个根独立 `validateCwd`/realpath/allow-root/重叠/alias/delegated worktree 校验，query 模式收窄 Bash allowlist 并为 context root 注入绝对路径 sensitive-file deny；background fingerprint 纳入排序后的 roots |
| FUNC-011 | Support rename/copy changes in claude_apply preview and apply | feature | P2 | M | 已完成：`04252b1`；`claude_apply` preview/apply 支持 git rename/copy 的 `R`/`C` 状态与 `old_file`，事务 apply 对 rename 备份新旧路径、copy 只备份目标路径，并保持 scope、dirty、submodule 与未知状态 fail-closed |
| UX-005 | Expose dedup_policy and reuse decision in claude_task result | ux/observability | P2 | S | 已完成：`16d9841`；`claude_task` 结果新增 `dedup_policy` 与 `reuse_decision`，区分 created/deduped/busy_existing/job_id/not_found，仅暴露调度可观测信息，不改变 fingerprint dedupe、并发或 wait 行为 |
| UX/RUN-GROUP-001 | Group repeated implement/fix runs by high-level goal item | ux/observability | P2 | M | 已完成：`pending commit`；新增可选 `goal_item_id` / `supersedes_run_id`，贯穿 `claude_task` write、`claude_implement`、background job、run log、`claude_runs` 过滤、`claude_result.run_group` 和 `claude_workspace_status.run_groups`；旧 run log/job record 兼容，dedupe fingerprint 与 `claude_apply` 安全语义不变 |
| OBS-001 | Add optional tool-call audit summary to run logs | observability/security | P2 | M | 已完成：`2ec1219`；从 run log `report.permission_denials`/`commands_run` 派生安全的 `tool_call_audit` 摘要，仅暴露 denied 数量、去重工具名、截断标记和命令计数，不暴露 `tool_input`、命令内容、路径或 stdout/stderr |
| AUDIT-DOCS-002 | Add schema/source-derived docs consistency checks | docs/safety | P1 | M | 已完成：`e9a71c8`；`audit-docs.mjs` 从 `src/server.ts`、`src/codex-config.ts`、`src/schema.ts` 和 plugin/package JSON 提取 manifest，新增默认工具数量、enabled_tools 列表、unknown tool name、claude_apply 元数据一致性、preview_token 格式、版本一致性检查；保留既有 regex/text 安全网；README 缺少高级工具仅 informational |
| STATE-MACHINE-001 | Add state-machine fault-injection coverage for background jobs, job store, and review gate | test/safety | P1 | M | 已完成：`4b6185b`；覆盖 dedupe 不复用 terminal job、enqueue spawn throw fail-closed、wait mid-state transition、recovery grace window / dead-pid / min-age、cleanup preserves active jobs、update non-existent returns null、review gate disabled no-op、fingerprint match/mismatch、second pending overwrite、corrupt/deleted state file fail-closed |

## 11. 建议的下一步执行顺序

如果只做一轮修复，建议按这个顺序：

1. SEC-001 事务型 apply。
2. SEC-002 active worktree lock。
3. SEC-008 禁止 nested delegated write worktree。
4. SEC-009 implement `resume_latest` 失效回退。
5. FUNC-002 完整 diff preview。已完成：`be94110`。
6. SEC-003 review gate run binding。已完成：`94aedc6`。
7. UX-001 中文 mode inference。已完成：`b6a0a2b`。

原因：这些问题覆盖了“不要半改/误删/嵌套分叉/恢复失败/盲签/误清审查/误路由”的主风险，都是用户信任的基础。`FUNC-001 high-level allowed_files` 很重要，但有 advanced tool 替代路径，适合放到第二轮顶部。

第二轮再做：

1. FUNC-001 high-level allowed_files。已完成：`0d25456`。
2. UX-006 nested apply path 清晰错误和 `permission_denials` warning。已完成：`11ddd68`。
3. SEC-006 server crash/orphan recovery。已完成：`b00ce5e`。
4. SEC-007 implement 并发保护。已完成：`03c56fc`。
5. SEC-004 env allowlist。已完成：`9e3a629`。
6. SEC-005 sensitive file deny。已完成：`8c9c574`。
7. FUNC-003 server verification。已完成：`f5b2a17`。
8. UX/docs 修正。

第三轮做竞品追赶：

1. branch/PR export。
2. environment config。
3. artifacts。
4. multi-repo read/review。
5. ignored files/submodule/rename 策略。
6. dedup/idempotency 可见性。
7. tool-call audit summary。

## 12. 资料来源

本报告参考了仓库当前代码、README、SECURITY 文档，以及以下官方资料：

- OpenAI Codex CLI command options: <https://developers.openai.com/codex/cli/reference>
- OpenAI Codex CLI docs: <https://developers.openai.com/codex/cli>
- Claude Code hooks: <https://docs.anthropic.com/en/docs/claude-code/hooks>
- Claude Code settings and permissions: <https://docs.anthropic.com/en/docs/claude-code/settings>
- Cursor Cloud Agents overview: <https://cursor.com/docs/cloud-agent>
- Cursor Cloud Agents setup: <https://cursor.com/docs/cloud-agent/setup>
- GitHub Copilot cloud agent overview: <https://docs.github.com/en/copilot/using-github-copilot/coding-agent/about-assigning-tasks-to-copilot>
- Aider edit formats: <https://aider.chat/docs/more/edit-formats.html>
- Aider usage: <https://aider.chat/docs/usage.html>
- Aider linting and testing: <https://aider.chat/docs/usage/lint-test.html>
- Cline MCP Marketplace: <https://docs.cline.bot/mcp/mcp-marketplace>
- Cline features / auto approve: <https://docs.cline.bot/features>
- Devin docs: <https://docs.devin.ai/>
