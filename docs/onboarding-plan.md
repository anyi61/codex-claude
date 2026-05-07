# 插件优先上手体验改造计划 v2

## Summary

将首选上手路径改为“安装 Codex 插件 -> 重启或加载 Codex -> 运行 `claude_setup` 自检 -> 用 `claude_task` 完成第一次委托”。本轮目标是让插件安装路径与实际运行路径一致：插件提供自包含 MCP runtime，不再依赖仓库根目录被忽略的 `dist/server.js`。

## Implementation Changes

- 使用 `esbuild` 生成插件 runtime。新增 devDependency `esbuild`，新增脚本 `build:plugin`，从 `src/server.ts` 打包到 `plugins/codex-claude-delegate/server/server.js`。
- 更新 `package.json`：在 `devDependencies` 中添加 `"esbuild": "^0.25.0"`，在 `scripts` 中添加 `build:plugin` 和 `check:plugin`。
- 将 `plugins/codex-claude-delegate/.mcp.json` 的 MCP server 入口固定为 `${CLAUDE_PLUGIN_ROOT}/server/server.js`。该产物路径不受当前 `/dist/` ignore 规则影响，构建后应可提交。
- 保留现有开发路径：`npm run dev` 继续运行源码，`npm run build` 继续只产出根目录 `dist/`，手动 MCP 配置作为 README 的次级“Manual install / Development”路径。
- 以 `plugins/codex-claude-delegate/.codex-plugin/plugin.json` 作为 Codex 插件主配置；`.claude-plugin/plugin.json` 作为兼容元数据保留。版本号需要与 `package.json` 保持一致。
- README 只做上手路径校准，不做大范围重写：顶部说明价值，Quick Start 聚焦插件安装、自检和第一次成功运行；已有 Default / Advanced 工具分层保留。
- 技能文件以确认和微调为主。`claude-delegate.md` 已经推荐 `claude_task` 作为普通入口，本轮最多补充一行指向新 Quick Start 的安装或首跑说明。

## Implementation Decisions

- `build:plugin` 必须使用 esbuild 单文件 bundle，不采用 tsc 输出复制方案。脚本命令固定为 `esbuild src/server.ts --bundle --platform=node --target=node22 --format=esm --packages=bundle --outfile=plugins/codex-claude-delegate/server/server.js`，要求 `esbuild` 版本为 `^0.25.0`。
- `plugins/codex-claude-delegate/server/server.js` 是 repo-tracked release artifact。实现完成后必须生成并提交该文件，保证最终用户安装插件后不需要本地构建。
- 必须新增 `check:plugin` 脚本，而不是在测试或人工步骤中二选一。该脚本使用 `scripts/check-plugin.mjs` 实现，至少验证三件事：`.mcp.json` 指向的 server 文件存在、server 文件不被 `.gitignore` 忽略、Node 启动该 server 不出现缺失依赖加载错误。
- 除非 bundle 暴露纯加载层面的 ESM 或路径问题，不修改 `src/` 中 MCP 工具行为、schema、job 状态机或 apply 逻辑。
- README 只允许改动上手相关内容：项目顶部介绍、`Quick start`、`Configuration`、`Troubleshooting` 中与插件安装路径直接相关的段落。不要重排 Tools 表格或重写高级工具说明。
- 本轮继续使用 `${CLAUDE_PLUGIN_ROOT}`，因为现有 `.mcp.json` 和 `hooks/hooks.json` 已依赖该变量。实现阶段先确认插件安装路径和变量解析是否正常；如果变量在 Codex 插件环境中不可用，停止并报告，不自行设计替代路径。
- 最终验证命令顺序固定为：`npm run build`、`npm run build:plugin`、`npm run check:plugin`、`npm test`、`npm run typecheck`。

## User And Maintainer Flow

- 最终用户安装已打包插件后，不需要在插件目录运行 `npm install` 或 `npm run build`。
- 维护者或贡献者从源码构建插件时，需要运行 `npm install`，然后运行 `npm run build:plugin` 生成 `plugins/codex-claude-delegate/server/server.js`。
- 开发和迭代过程中，每次修改 `src/` 后都需要运行 `npm run build:plugin && npm run check:plugin`，确保插件 runtime 与源码同步。
- 插件 runtime 应 bundle 运行依赖，例如 `@modelcontextprotocol/sdk` 和 `zod`。不要采用“复制 tsc 输出但依赖 node_modules”的方案，因为这不满足自包含插件目标。

## Compatibility And Risks

- MCP 工具名、输入输出 schema、job 状态机、apply 语义不变。
- `.mcp.json` 路径变更可能影响手动复制或软链插件目录的早期用户；README 需要说明重新构建或重新安装插件。
- 必须验证 `${CLAUDE_PLUGIN_ROOT}` 在 Codex 插件 MCP server 和 hooks 配置中可用。`hooks/hooks.json` 已依赖该变量；若环境不支持，本轮停止并报告，不自行设计替代路径。
- 不把 bundle 体积作为硬性阻塞标准，但应记录产物大小；如果异常大，再决定是否外部化 Node 内置模块或调整 bundle 策略。
- 本轮不要求为插件 bundle 生成 source map。调试时优先使用 `npm run dev` 或根目录 `npm run build` 产物；后续如需要再单独增加 sourcemap 支持。

## Test Plan

- `npm run build`：确认原 TypeScript 编译仍产出根目录 `dist/`。
- `npm test` 和 `npm run typecheck`：确认现有行为未回归。
- `npm run build:plugin`：确认生成 `plugins/codex-claude-delegate/server/server.js`。
- `git check-ignore -q plugins/codex-claude-delegate/server/server.js; test $? -eq 1`：确认插件 runtime 不被 `.gitignore` 忽略。
- `node plugins/codex-claude-delegate/server/server.js < /dev/null`：确认不会因缺失运行依赖出现 `ERR_MODULE_NOT_FOUND` 或类似加载错误。
- `npm run check:plugin`：检查 `plugins/codex-claude-delegate/.mcp.json` 指向的文件存在，插件 runtime 不被忽略，且 Node 可加载 runtime。
- 在 Codex 插件环境中验证最小链路：`claude_setup` 成功，`claude_task(mode="read")` 返回 `job_id`，`claude_job_wait` 可轮询到终态。
- 验证 `hooks/review-gate-stop.mjs` 在插件环境下仍能通过 `${CLAUDE_PLUGIN_ROOT}` 被解析和执行。

## Assumptions

- 本轮只优化 Codex 插件用户的首次安装和首次成功体验。
- npm / `npx` 分发路径后续再设计，不作为本轮主入口。
- Claude 插件元数据保持兼容保留，但不扩大到完整 Claude Desktop 安装体验验证。
