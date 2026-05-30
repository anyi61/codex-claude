# 问题确认清单

评审来源：`/Users/anyi/.codex/attachments/f7b22d0c-0868-4a0f-989d-ad45dd635ab2/pasted-text.txt`

确认时的仓库状态：

- 分支：`main`
- 版本：`@anyi61/codex-claude-delegate-mcp@0.1.13`
- 写入本文件前工作区：干净

## 状态说明

- `已确认`：该判断与当前代码一致。
- `部分确认`：核心判断成立，但代码里已有一定缓解措施，或文档里已有部分说明。
- `未确认`：该判断与当前代码不一致。
- `需要决策`：事实已经确认，后续属于产品或安全策略选择。

## Claude 复核结论

已将原始评审文本和本清单交给 Claude 复核。Claude 没有提出反对项，整体认可这些问题的代码证据和风险判断。它指出的细节修正已经合并到下表：

- 路径边界 helper 已存在：`src/guard.ts:234` 的 `resolveRepoLocalPath()`，后续应复用它，而不是新增重复 helper。
- `claude_task` 预算项属于产品策略选择，README 已有说明，清单需要把问题重点放在默认入口是否继续隐藏底层预算字段。
- SECURITY.md 预算表的问题是“适用范围不够清楚”，而不是字段本身不存在。
- `execCapture()` 的风险要区分“不传 env 时继承父环境”和“传 env 时合并父环境”两个场景。
- 需要用户或产品策略裁决的点：无。
- 已裁决：`VERIFICATION-SCRIPT-002` 保持不限制 `npm test` / `npm run` 等 package-manager scripts，以保留 Claude 自主验证能力；优先通过 `VERIFICATION-ENV-001` 的环境清洗降低泄露风险，并在文档中明确该执行面。
- 已裁决：`ALLOW-ROOTS-DOC-001` 采用覆盖语义；`CODEX_CLAUDE_ALLOW_ROOTS` 存在时就是完整白名单。新增目录通过 setup 写入配置，避免用户理解“默认 + 追加”的隐式组合。
- 已裁决：`CLAUDE-TASK-BUDGET-001` 保持 `claude_task` 不暴露底层预算字段，以维持默认入口简单和 Claude 自主性；需要硬预算控制时使用高级工具，并把 README/SECURITY.md 的适用范围说明清楚。

## 清单

| ID | 优先级 | 问题判断 | 状态 | 可能影响 / 通俗例子 | 证据 | 建议动作 |
|---|---:|---|---|---|---|---|
| `VERIFICATION-ENV-001` | P0 | `verification_commands` 启动的子进程继承完整父进程环境，没有使用 `sanitizeEnv()`。 | 已确认 | 可能泄露本机或 CI 环境里的 token、cookie、API key。例子：用户让 server 跑 `npm test`，delegated worktree 里的测试脚本可以读取 `process.env.GITHUB_TOKEN` 并打印到 verification 日志里。 | `src/verification.ts:157` 调用 `spawn(bin, args, { cwd, stdio })`，没有传 `env`。`src/guard.ts:384` 定义了 `sanitizeEnv()`，Claude/background 进程路径在其他地方已经使用清洗后的环境。 | verification 子进程改为传入清洗后的环境。新增回归测试，验证未白名单的 secret 类环境变量在 verification 命令中不可见。 |
| `VERIFICATION-SCRIPT-002` | P0/P1 | `npm test`、`npm run <script>`、`yarn/pnpm test`、`yarn/pnpm run <script>` 被允许，但它们会执行 delegated worktree 中仓库可控的脚本。 | 已确认，已裁决：不限制 | 可能把“看起来是测试”的命令变成任意仓库脚本执行。例子：Claude 改了 worktree 里的 `package.json`，把 `test` 改成 `node scripts/upload-env.js`，server 随后运行 `npm test` 就会执行这段脚本。 | `src/verification.ts:100` 允许 `npm test`；`src/verification.ts:102` 允许 `npm run <script>`，只受 forbidden names 和可选 allowlist 限制。`src/verification.ts:108`-`110` 对 `yarn` 和 `pnpm` 使用同类逻辑。README 在 `README.md:256` 记录了该行为。 | 决策：保持不限制 package-manager scripts，以保留 Claude 自主验证能力，避免用户频繁补充验证命令。后续重点改为：先修 `VERIFICATION-ENV-001`，确保 verification 子进程使用 `sanitizeEnv()`；文档明确 `npm test` / `npm run` 会执行 worktree 内脚本，属于更宽的验证执行面。 |
| `ALLOW-ROOTS-DOC-001` | P1 | `CODEX_CLAUDE_ALLOW_ROOTS` 文档写成“扩展”，但代码行为是替换默认 roots。 | 已确认，已裁决：覆盖 | 可能造成配置误解，导致原本默认允许的仓库突然不能用。例子：用户以为加了 `/tmp/my-repo` 后仍能操作 `~/projects/foo`，实际 env 存在后默认 roots 被替换，`~/projects/foo` 会被拒绝。 | `src/guard.ts:69`-`72`：env 存在时，`getAllowRoots()` 只返回 env roots。默认 roots 只在 env 缺失时从 `src/guard.ts:73`-`78` 返回。`SECURITY.md:77` 写的是通过环境变量扩展。 | 决策：采用覆盖语义，保持当前代码行为。后续把文档从“扩展”改为“覆盖默认白名单”；新增目录通过 `claude_setup(configure_allow_root=true)` / setup 写入配置，避免“默认 + 追加”的理解成本。 |
| `APPLY-PATH-BOUNDARY-001` | P1 | 事务 apply 直接用 `path.join()` 拼接 repo-relative 文件名，apply 层没有二次 repo-boundary 校验。 | 已确认 | 未来上游 parser 或调用方出错时，可能写到仓库外。例子：某个 change entry 的文件名变成 `../outside.txt`，`path.join(cwd, "../outside.txt")` 会指向仓库父目录里的文件。 | `src/transaction.ts:94`、`src/transaction.ts:122`、`src/transaction.ts:169`、`src/transaction.ts:176`、`src/transaction.ts:231` 都用 `path.join(root, file)` 派生写入、读取或删除路径。`src/guard.ts:234` 已有 `resolveRepoLocalPath()`，但 apply 逻辑尚未使用它。 | 复用已有 `resolveRepoLocalPath()`，拒绝绝对路径和 `..` 逃逸。用于目标路径、来源路径、备份路径、rollback 路径。补 transaction 测试覆盖 `../escape`、绝对路径、rename `old_file` 逃逸。 |
| `DIRTY-SNAPSHOT-PATH-001` | P1 | dirty snapshot 复制/删除逻辑使用 `path.join(cwd, entry.file)` 和 `path.join(worktreePath, entry.file)`，本函数内没有边界 helper。 | 部分确认 | 如果以后 dirty entry 的来源变复杂，快照复制可能把仓库外文件复制进 worktree，或删除 worktree 外路径。例子：entry.file 异常变成 `../../notes.txt`，snapshot 逻辑会用它参与 source/destination 拼接。 | `src/worktree-observer.ts:45`-`47` 已经先用 `normalizeRepoPath(cwd, entry.file)` 归一化 dirty entries。snapshot 应用阶段仍在 `src/worktree-observer.ts:67`-`68` 使用 `path.join`。`src/guard.ts:234` 已有 `resolveRepoLocalPath()`，但 snapshot 逻辑尚未使用它。 | 在这里也复用 `resolveRepoLocalPath()`，作为纵深防御。虽然当前上游归一化降低了暴露面，写入边界处仍建议自校验。补测试覆盖恶意 parser 输出或直接 helper 调用。 |
| `CLAUDE-TASK-BUDGET-001` | P1 | `claude_task` 是默认入口，但没有暴露 `timeout_sec`、`max_turns`、`max_cost_usd`。 | 部分确认，已裁决：不暴露 | 用户难以控制默认入口的实际执行预算，容易把 `wait_timeout_sec` 误认为任务总超时。例子：用户设置 `wait_timeout_sec=60`，以为 60 秒后任务会停止，实际 Claude 任务仍可能在后台继续跑到内部 3600 秒上限。 | `src/schema.ts:812`-`823` 在 `claude_implement` 暴露了 `timeout_sec`、`max_turns`、`max_cost_usd`；`src/schema.ts:840`-`863` 的 `claude_task` 没有这些字段。`src/claude-cli.ts:566` 把 task 内部超时固定为 `3600`，并在 `src/claude-cli.ts:577`、`src/claude-cli.ts:587`、`src/claude-cli.ts:615` 传给底层任务。README 已在 `README.md:262`-`266` 说明该行为。 | 决策：保持 `claude_task` 不暴露底层预算字段，以维持默认入口简单和 Claude 自主性。需要硬预算控制时使用高级工具（`claude_query` / `claude_review` / `claude_implement`）。后续把 SECURITY.md 的预算表拆清楚，明确 `wait_timeout_sec` 只是 inline wait，底层预算字段属于高级工具。 |
| `SECURITY-BUDGET-DOC-001` | P1 | SECURITY.md 的预算表适用范围不够清楚，容易让人以为 `max_turns` / `max_cost_usd` 也适用于 `claude_task`。 | 部分确认 | 安全预期可能和实际行为不一致。例子：安全审计人员看到表里有 `max_cost_usd <= 10`，以为默认入口也受这个字段约束，但 `claude_task` schema 实际不接受该字段。 | `SECURITY.md:336`-`338` 把 `max_turns`、`max_cost_usd`、`wait_timeout_sec` 放在同一张表里。README 在 `README.md:266` 明确 `claude_task` 不接受 `max_turns`。 | 把 SECURITY.md 拆清楚：高级工具预算和 `claude_task` inline wait 分开说明。 |
| `MODE-INFERENCE-001` | P2 | 自动 mode inference 基于正则和优先级链，中文混合 review/write 意图可能误判。 | 已确认 | 可能把用户想要的审查任务误路由为写入任务。例子：用户说“优化一下这段逻辑有什么风险”，系统先命中“优化”这个写入词，可能走 write，而用户实际想问风险分析。 | 关键词正则在 `src/claude-cli.ts:199`-`212`。`inferClaudeTaskMode()` 的优先级是 constraints、query prefix、write hints，再到 review hints，见 `src/claude-cli.ts:235`-`280`。 | 增加混合 prompt 测试，例如“检查这个实现有没有问题，顺手修一下”、“看下 package.json 的 update script 安不安全”、“优化一下这段逻辑有什么风险”。之后决定改成 scoring，或增加对风险/检查/安全类表述的保守 review-first 规则。 |
| `EXEC-CAPTURE-ENV-001` | P2 | 通用 `execCapture()` 默认继承父进程环境；传了 `opts.env` 时也会把父环境合并进去。 | 已确认 | 未来维护者可能把它用在不可信 worktree 命令上，从而重复 verification 的环境泄露问题。例子 1：新功能用 `execCapture("npm", ["test"], { cwd: worktree })`，不传 env 时会默认继承完整环境。例子 2：新功能传 `{ FOO: "bar" }` 时，实际环境是 `{ ...process.env, FOO: "bar" }`，父环境仍然保留。 | `src/guard.ts:467` 使用 `env: opts.env ? { ...process.env, ...opts.env } : undefined`。不传 env 时，Node 默认继承父进程环境。 | 拆分 helper 语义或改名：trusted local capture 可以继承 env；untrusted workspace capture 默认使用 `sanitizeEnv()`。改前需要审计现有调用点，因为很多调用是 git / Claude CLI 本地可信操作，可能需要继承 env。 |
| `STATIC-ANALYSIS-001` | P2 | 项目缺少 lint、format、dead-code、安全静态分析脚本。 | 已确认 | 安全边界类问题更容易在后续改动中悄悄出现。例子：有人新增一个 `spawn()`，忘了传 `env` 或用了 `shell: true`，当前 CI 可能只靠类型和单测发现不了。 | `package.json:26`-`45` 的 scripts 包含 build、typecheck、test、release checks、docs audit，没有 `lint`、`format:check`、`deadcode`、`security:grep`。`package.json:51`-`56` 的 devDependencies 有 TypeScript/Vitest/esbuild/tsx，没有 ESLint/Biome/Prettier/Knip/Semgrep。 | 分阶段增加最小静态分析层。建议第一步加 ESLint 或 Biome，重点规则覆盖 child process env、shell 使用、路径穿越、危险 fs 操作。 |

## 额外观察

- `verification_commands` 会解析成 argv，并且不经过 shell 执行，这能缓解 shell 元字符注入。证据：`src/verification.ts:39`-`83` 的 parser，以及 `src/verification.ts:98` 的 forbidden token 检查。
- verification 命令 allowlist 当前会通过 `FORBIDDEN_SCRIPT_NAMES` 阻止明显高风险脚本名，如 `install`、`publish`、`start`、`deploy`。证据：`src/verification.ts:11`-`20`。
- dirty snapshot 的路径风险低于 transaction apply，因为 dirty entries 在复制/删除前会经过 `normalizeRepoPath()`。但该函数会写入主工作区和 delegated worktree，写入边界处仍建议增加本地校验。
- README 已说明 `claude_task` 使用固定内部执行超时，且不接受 `max_turns`；SECURITY.md 应该保持同等明确。

## 建议修复顺序

1. `VERIFICATION-ENV-001`：verification 子进程传 `sanitizeEnv()`，并测试 secret 剥离。
2. `APPLY-PATH-BOUNDARY-001` + `DIRTY-SNAPSHOT-PATH-001`：复用已有 `resolveRepoLocalPath()`，并补逃逸测试。
3. `ALLOW-ROOTS-DOC-001`：按已裁决策略采用覆盖语义，更新 SECURITY.md/README 等文档表述。
4. `VERIFICATION-SCRIPT-002`：按已裁决策略保持不限制 package-manager scripts；修复环境清洗并补充风险文档。
5. `CLAUDE-TASK-BUDGET-001` + `SECURITY-BUDGET-DOC-001`：按已裁决策略保持 `claude_task` 不暴露底层预算字段；澄清 README/SECURITY.md 中默认入口和高级工具预算的适用范围。
6. `MODE-INFERENCE-001`：先加混合意图测试，再调整推断策略。
7. `EXEC-CAPTURE-ENV-001` + `STATIC-ANALYSIS-001`：通过 helper 命名和静态检查降低后续安全语义漂移。
