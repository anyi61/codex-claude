# 仓库指南

## 项目结构与模块组织
本仓库实现了 `codex-claude-delegate-mcp`，一个让 Codex 将任务委托给 Claude Code 的 TypeScript MCP 服务器。

- `src/server.ts`：MCP stdio 服务器、工具注册与请求分发。
- `src/claude-cli.ts`：Claude CLI 的启动与结果收集。
- `src/guard.ts`：cwd 白名单检查、环境清理与递归保护。
- `src/schema.ts`：共享类型、JSON 结果辅助函数以及提示词/模式定义。
- `debug/`：用于 MCP 和实现流程检查的临时 TypeScript 脚本。
- `dist/`：构建输出目录。请勿手动编辑；使用 `npm run build` 重新生成。
- `README.md`、`SPEC.md`、`CLAUDE.md`：用户文档、实现规范以及面向代理的项目说明。

## 构建、测试与开发命令

- `npm install`：安装运行时和 TypeScript 工具依赖。
- `npm run dev`：通过 `tsx` 从 `src/server.ts` 运行 MCP 服务器，用于本地开发。
- `npm run build`：将严格的 TypeScript 编译到 `dist/` 目录，包含声明文件和 source maps。
- `npm start`：从 `dist/server.js` 运行编译后的服务器。
- `npx tsx debug/mcp-test.ts`：调试时运行 MCP 冒烟测试脚本，用于验证工具行为。
- `npx tsx debug/test-implement.ts`：测试实现委托流程。

## 编码风格与命名规范
使用 TypeScript ES 模块，在相对导入中显式添加 `.js` 扩展名，以匹配 Node16 模块解析。保持 `strict` TypeScript 清洁，优先使用类型化结果对象而非松散结构的 JSON。使用两个空格缩进、双引号、分号，变量和函数使用 `camelCase`，导出类型和类使用 `PascalCase`。将安全敏感检查集中放在 `guard.ts` 中，避免在处理器中重复策略逻辑。

## 测试指南
目前尚未配置正式的测试运行器。在提交更改前，请将 `npm run build` 作为基准检查。对于行为变更，请在 `debug/` 下添加或更新针对性脚本，并记录所使用的确切命令。按场景命名调试脚本，例如 `debug/test-worktree.ts` 或 `debug/mcp-status.ts`。

## 提交与 PR 指南
近期历史遵循 Conventional Commits 规范：`feat: ...`、`fix: ...`、`docs: ...`。保持提交主题为祈使语气，并限定为单一逻辑变更。Pull Request 应包含简短的问题描述、变更摘要、已运行的验证命令、关联问题（如适用），以及子进程执行、允许根目录、工作树或环境处理相关的安全影响说明。

## MCP Tool Usage Policy

Default Codex workflows should use only:

- `claude_setup`
- `claude_task`
- `claude_job_wait`
- `claude_result`
- `claude_apply`
- `claude_cleanup`

Do not call `claude_query`, `claude_review`, or `claude_implement` directly for ordinary work. Do not call `claude_jobs`, `claude_job_result`, or `claude_runs` directly for ordinary polling. These are Advanced / Debug tools for diagnostics, rescue, or explicit expert workflows.

When `claude_task` returns a job, that job is the single execution source for the request. Continue with `claude_job_wait` until the job reaches a terminal state or is explicitly cancelled. If `claude_job_wait` returns `waiting=true`, do not implement the same task locally and do not create another job for the same task. If it returns `poll_too_soon=true`, wait until `next_allowed_poll_at` before polling the same `job_id` again.

For ordinary `claude_task` calls, do not pass `files`. If Claude should read a plan, checklist, or requirements file, pass it as `instruction_files` or mention it in `task`. `claude_task.files` is deprecated and is treated only as instruction context, not as apply scope. Use Advanced / Debug `claude_implement.files` only when strict file modification limits are explicitly required.

## 安全与配置提示
不要向 Claude 子进程传递密钥。保持环境清理、危险命令拦截以及 `BRIDGE_DEPTH` 递归保护。在配置允许根目录时，尽量使用 `CODEX_CLAUDE_ALLOW_ROOTS` 环境变量，而非硬编码本地路径。
