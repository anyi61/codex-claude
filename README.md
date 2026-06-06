# codex-claude-delegate-mcp

通过本地 MCP server，让 Codex CLI 把读取、审查、实现任务委托给 Claude Code。
Claude 可以在受控权限下读取仓库；写入任务在隔离 git worktree 中完成，Codex 预览后再应用到主工作区。

> 非官方项目：这不是 OpenAI 或 Anthropic 官方产品。它会在你的本机启动 Claude Code CLI，并允许 Claude 在受控 allowlist 内读取文件、运行命令、在隔离 git worktree 中写入。它不是强沙箱；只在你信任的本地仓库和可信 Claude CLI 路径中使用。
>
> 安全边界、命令限制和敏感文件规则见 [SECURITY.md](./SECURITY.md)。

## 快速开始

前置条件：

- 已安装并登录 Codex CLI。
- `node` >= 20 且在 PATH 中。
- Claude Code CLI `claude` 在 PATH 中，或设置 `CLAUDE_BIN`。
- Git 可用；写入模式需要 git worktree 支持。

```bash
npm install -g @anyi61/codex-claude-delegate-mcp
codex-claude setup --write --allow-root "$(pwd)"
codex-claude doctor
```

`codex-claude doctor` 通过后，应满足：Codex 能找到 `claude_delegate`，当前仓库已加入 allow roots，Claude CLI 可启动，默认工具已启用。

## 功能概览

- 委托读取、审查和实现任务给 Claude Code。
- 写入任务在隔离 git worktree 中运行，主工作区只由 `claude_apply` 修改。
- `claude_task` 默认 inline wait，减少轮询和上下文消耗。
- 预览优先：先查看 planned changes，再确认 apply。
- 默认限制危险命令和敏感文件读取；细节见 [SECURITY.md](./SECURITY.md)。

## One Message To Codex

```text
请先调用 claude_setup 检查当前仓库。
如果 ready，请用 claude_task 的 read 模式总结这个仓库的结构、测试命令和适合委托给 Claude 的任务类型。
```

常见请求：

```text
用 claude_task read 模式解释这个模块如何工作。
用 claude_task review 模式审查当前 diff，优先找 bug 和遗漏测试。
用 claude_task write 模式实现这个改动；完成后先 claude_apply preview=true 给我看。
```

## 默认工具

`setup --write` 和 `print-config` 默认启用这 5 个工具：

| 工具 | 用途 |
|------|------|
| `claude_setup` | 检查当前仓库是否可安全使用。 |
| `claude_task` | 推荐入口；自动路由到 read / review / write，默认等待结果。 |
| `claude_result` | 获取最近完成的结果和下一步建议。 |
| `claude_apply` | 预览或应用 delegated worktree 的变更。 |
| `claude_cleanup` | 清理过期 delegated worktree，默认 dry-run。 |

高级工具需要手动启用；见 [Advanced Tools](./docs/advanced-tools.md)。`claude_job_wait` 是 Advanced / Recovery 工具，普通恢复路径使用 `claude_task(job_id=...)`。

## 工作流

`claude_task` 默认在 MCP server 内等待 Claude 完成，完成时直接返回标准化结果。默认等待窗口是 540 秒，因为 `setup --write` 会配置 600 秒 MCP tool timeout，保留约 60 秒给 Claude 启动、结果汇总和响应返回。大型任务超出等待窗口时会返回 `job_id`。

典型流程：

```text
1. claude_setup
2. claude_task(mode="read" 或 "write", ...)
3. 写入结果：claude_apply(preview=true)
4. 用户审查 planned_changes
5. claude_apply(confirmed_by_user=true, preview_token="...", cleanup=true)
6. claude_cleanup(dry_run=true)
```

### 只读或审查

```text
claude_task(mode="read", cwd="/path/to/repo", task="解释认证流程")
claude_task(mode="review", cwd="/path/to/repo", task="审查当前改动")
```

read / review 结果无需 apply。

### 写入、预览、应用

```text
claude_task(mode="write", cwd="/path/to/repo", task="实现特性 X")
  -> Claude 在 .claude/worktrees/codex-delegated-* 中修改
  -> claude_apply(cwd="...", worktree_path="...", preview=true)
  -> 用户审查 planned_changes
  -> claude_apply(cwd="...", worktree_path="...", confirmed_by_user=true, preview_token="...", cleanup=true)
```

`preview=true` 不修改主工作区。非预览 apply 需要明确确认和匹配的 `preview_token`。

### 长任务恢复

```text
claude_task(...) -> status="running", job_id="job-..."
claude_task(cwd="/path/to/repo", job_id="job-...")
```

继续等待同一个 `job_id`，避免重复启动相同任务。

### 失败或部分完成

write 任务返回 `partial`、`failed` 或 `needs_user` 时，先检查结果。如果存在 worktree，先运行 `claude_apply(preview=true)` 查看已有改动；如果存在可恢复 session，再决定是否 `resume_latest=true`。不要自动 apply、resume 或 cleanup。

## 重要参数

- **instruction_files vs `files`：** 对 `claude_task`，规格、计划、清单等上下文文件放在 `instruction_files`。`claude_task.files` 已废弃，只作为上下文文件兼容处理，不是修改范围限制。
- **多步骤 write task：** 先写 execution plan，并通过 `instruction_files` 传给 `claude_task`。`instruction_files` 只提供上下文；修改范围仍用 `allowed_files` 控制。
- **`allowed_files`：** write 模式的硬文件范围。只有列出的文件可以被修改；超出范围的变更会被拒绝。
- **`security_profile="default"`：** 默认写入权限配置会限制危险命令和远程包执行路径。更详细的安全模型见 [SECURITY.md](./SECURITY.md)。
- **`sensitive_file_policy`：** 控制 `.env`、`secrets/**` 等敏感文件读取限制。细节见 [SECURITY.md](./SECURITY.md)。
- **`context_roots` 和 `verification_commands`：** 属于进阶工作流；见 [Workflows](./docs/workflows.md)。

## 配置

常用配置命令：

```bash
codex-claude setup --write --allow-root "$(pwd)"
codex-claude print-config
codex-claude doctor --json
```

Allow roots、环境变量透传、`.codex-claude-delegate/environment.json` 和本地状态清理见 [Configuration Reference](./docs/configuration-reference.md)。

## 故障排查

| 问题 | 处理 |
|------|------|
| `claude` 命令未找到 | 安装 Claude Code CLI，或设置 `CLAUDE_BIN`。 |
| cwd 不在 allow roots 中 | 运行 `codex-claude setup --write --allow-root "$(pwd)"`。 |
| `waiting=true` / `completed_inline=false` | 使用 `claude_task(job_id=...)` 继续等待同一任务。 |
| 缺少 `confirmed_by_user` | 展示预览并获得用户明确批准后再应用。 |
| 缺少 `preview_token` | 先调用 `claude_apply(preview=true)` 获取 token。 |
| `preview_token` 不匹配 | worktree 或主工作区目标文件在预览后变化；重新 preview。 |
| 主工作区冲突导致 apply 拒绝 | 查看 conflicts 字段，处理未提交、未跟踪、gitignored 或路径冲突后重试。 |
| 服务端验证失败阻止 apply | 验证失败时非预览 apply 被阻止。使用 `preview=true` 检查 worktree，修复问题后重新委托。 |
| 残留 worktree | `claude_cleanup(cwd="...", dry_run=true)` 预览后再清理。 |
| Claude 不能 `npm publish` / `git push` | 这些命令被安全策略拦截；由 Codex 或用户在主工作区执行发布和推送。 |

## 卸载

```bash
codex-claude uninstall --yes
npm uninstall -g @anyi61/codex-claude-delegate-mcp
```

先运行 `codex-claude uninstall`，再卸载 npm 包。卸载命令会清理 Codex 中的 MCP 配置和本工具维护的 allow-root 配置，并报告残留 workspace state 或 delegated worktree。

## 已知限制

- 不支持实时双向通信；Codex 向 Claude 单向委托任务。
- 每次调用 Claude 通常有几秒冷启动。
- 已完成的 delegated worktree 需要通过 `claude_cleanup` 清理。
- 旧 job/run log 可能缺少指纹或心跳，过期分类会回退到 `updated_at`。
- 过期检测只用于提示，不会自动终止 Claude 进程。

## 更多文档

- [Workflows](./docs/workflows.md)：详细 read / review / write / apply / cleanup 流程。
- [Advanced Tools](./docs/advanced-tools.md)：非默认工具、后台任务和恢复工具。
- [Configuration Reference](./docs/configuration-reference.md)：allow roots、env passthrough、environment.json、cleanup-artifacts。
- [SECURITY.md](./SECURITY.md)：安全模型、命令限制、敏感文件保护、apply 边界。
- [CONTRIBUTING.md](./CONTRIBUTING.md)：源码构建、检查命令和维护者发布流程。
