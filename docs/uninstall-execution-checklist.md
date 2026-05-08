# 一键卸载插件执行清单

## 1. 目标行为

实现一个一键卸载入口，用于卸载 `codex-claude-delegate` 插件并移除对应的 `claude_delegate` MCP server。卸载流程应覆盖插件市场条目、MCP server 注册、Codex 配置残留、review-gate hook、本地运行状态目录，并对 delegated worktree 做检测提示。

卸载完成后的目标状态：

| 维度 | 目标状态 |
| --- | --- |
| 插件市场 | 本地 marketplace 中不再保留 `codex-claude-delegate` 条目 |
| MCP server | Codex 中不再注册 `claude_delegate` |
| Codex 配置 | `~/.codex/config.toml` 中不再保留本插件产生的 `claude_delegate` MCP 残留和当前仓库 allow-root |
| 本地状态 | `.codex-claude-delegate/` 按用户选择全部删除、全部保留或部分保留 |
| Review gate | hook manifest 中不再引用本插件 review-gate hook |
| Delegated worktree | 只检测和报告 `.claude/worktrees/codex-delegated-*`，不自动删除 |

## 2. 非目标行为

- 不删除当前仓库目录本身。
- 不自动重启 Codex，只在结束时提示用户重启。
- 不自动删除 `.claude/worktrees/codex-delegated-*`，只提示运行 `claude_cleanup` 或手动清理。
- 不在 `--yes` 模式下删除可疑的手动 MCP 配置；只报告需要人工确认。
- 不修改与 `claude_delegate` 无关的 MCP server、环境变量、hook 或用户配置。

## 3. 文件级清单

### `src/codex-config.ts`

新增可测试的 TOML 扫描和清理函数。卸载脚本只负责调用这些函数，不直接实现危险的 TOML 写入逻辑。

新增纯函数：

- `removePathFromAllowRootsValue(currentValue, pathToRemove, delimiter): string | null`
  - 使用 `path.resolve` 规范化路径。
  - 不做大小写折叠。
  - 移除后列表为空时返回 `null`。
- `deleteTomlTableKey(config, tableName, key): string`
  - 只删除指定 table 下指定 key 的赋值行。
  - 不删除其他 key，不删除无关 table。
- `readTableKeys(config, tableName): string[]`
  - 返回指定 table 下的 key 列表。
- `classifyMcpServerSection(config): McpServerClassification`
  - `origin = "auto"`：`command = "node"` 且 `args` 指向本插件 server，例如 `./server/server.js` 或 `codex-claude-delegate/server/server.js`。
  - `origin = "env_only"`：只有 `[mcp_servers.claude_delegate.env]` 子段，没有 `command` / `args`。
  - `origin = "manual"`：其他情况，包括 `command` / `args` 指向非本插件路径。

新增导出 IO 函数：

- `scanClaudeDelegateConfig(): Promise<ClaudeDelegateConfigScan>`
  - 只读扫描 `~/.codex/config.toml`。
  - 配置文件不存在时返回空扫描结果，不抛错。
  - 报告 allow-roots 位置、`[mcp_servers.claude_delegate]`、`[mcp_servers.claude_delegate.env]` 以及相关 key。
- `removeAllowRoot(cwd: string): Promise<RemoveAllowRootResult>`
  - 从 `CODEX_CLAUDE_ALLOW_ROOTS` 中移除指定仓库路径。
  - 路径不存在时 `changed: false`，不写磁盘。
  - 只操作 `CODEX_CLAUDE_ALLOW_ROOTS`，保留同 table 下其他变量。
- `removeOrFlagMcpServerSection(): Promise<RemoveMcpServerResult>`
  - `auto`：删除整个 `[mcp_servers.claude_delegate]`，包括 `.env` 子段。
  - `env_only`：删除 `.env` 子段；父段为空时一并删除父段。
  - `manual`：不删除，返回提示，由脚本在交互模式下询问用户。

### `scripts/uninstall-plugin.mjs`

新增卸载编排脚本。

执行阶段：

1. `scanResources()`
   - 扫描 marketplace、MCP server、`~/.codex/config.toml`、`.codex-claude-delegate/`、review-gate hook、delegated worktree。
2. `phaseRemoveMarketplace()`
   - 执行 `codex plugin marketplace list`，自动检测名称。
   - 执行 `codex plugin marketplace remove <name>`。
   - 检测失败时输出手动指引，不阻断后续步骤。
3. `phaseRemoveMcp()`
   - 先执行 `codex mcp remove claude_delegate`。
   - 失败时记录并继续。
4. `phaseCleanTomlRemainders()`
   - 重新扫描 `~/.codex/config.toml`。
   - 只清理 `codex mcp remove` 没清理干净的残留。
   - 如仍有 `[mcp_servers.claude_delegate]`：
     - `auto` / `env_only` 自动清理。
     - `manual` 在交互模式询问是否删除；`--yes` 模式跳过并报告。
   - 如仍有当前仓库 allow-root，调用 `removeAllowRoot(cwd)`。
5. `phaseHandleStateDir()`
   - 处理 `.codex-claude-delegate/`，仅提供三个选项：
     - 全部删除。
     - 全部不删除。
     - 由用户指定哪些保留。
6. `phaseReportWorktrees()`
   - 检测 `.claude/worktrees/codex-delegated-*`。
   - 只报告，不删除。
7. `phaseCleanHooks()`
   - 清理 review-gate hook 引用。
8. `printResult()`
   - 汇总成功项、失败项、跳过项和需要人工处理的项。

### `package.json`

新增 npm 入口：

```json
{
  "uninstall": "npm run build && node scripts/uninstall-plugin.mjs",
  "uninstall:dry-run": "node scripts/uninstall-plugin.mjs --dry-run"
}
```

说明：

- 正式卸载依赖 `dist/codex-config.js`，因此先运行 `npm run build`。
- `uninstall:dry-run` 不依赖 build；dry-run 只做只读扫描和输出，不执行写入。

### `tests/codex-config.test.ts`

新增单元测试和集成测试，覆盖 TOML 清理逻辑。

纯函数测试：

- `removePathFromAllowRootsValue` 正常移除。
- 路径不存在时不变。
- 移除最后一条路径时返回 `null`。
- 路径大小写不同不移除。
- `deleteTomlTableKey` 删除存在的 key。
- key 不存在时不变。
- `readTableKeys` 读取存在和不存在的 table。
- `classifyMcpServerSection` 覆盖 `auto`、`env_only`、`manual`。

IO 函数测试：

- 配置文件不存在时扫描不抛错。
- `removeAllowRoot` 从 `.env` 段移除。
- `removeAllowRoot` 从 `shell_environment_policy.set` 移除。
- `removeAllowRoot` 保留其他 env key。
- `removeAllowRoot` 重复调用幂等。
- `removeOrFlagMcpServerSection` 删除 `auto` 配置。
- `removeOrFlagMcpServerSection` 删除 `env_only` 配置。
- `removeOrFlagMcpServerSection` 遇到 `manual` 不删除。

### `tests/uninstall-plugin.test.ts`

新增脚本测试，mock `codex` CLI 和文件系统边界。

- `--dry-run` 不执行 remove 命令，不写文件，不删目录。
- `--yes` 跳过交互确认。
- `--keep-state=all` 保留全部状态。
- `--keep-state=none` 删除全部状态。
- `--keep-state=sessions,review-gate` 只保留指定项。
- marketplace 名称自动检测失败时输出手动指引。
- `codex mcp remove` 后重新扫描 TOML，并只补漏。
- 手动 MCP 配置在 `--yes` 模式下跳过并报告。
- delegated worktree 只报告，不删除。

### `README.md`

重写卸载章节，保留手动验证说明。

推荐文案结构：

````markdown
### 卸载

```bash
npm run uninstall:dry-run   # 预览将处理的资源，不产生副作用
npm run uninstall           # 交互式卸载
npm run uninstall -- --yes  # 非交互卸载，状态目录默认全部保留
```

卸载脚本会处理插件市场条目、MCP server、Codex 配置残留和 review-gate hook。`.codex-claude-delegate/` 会在交互中询问如何处理：全部删除、全部保留或指定保留项。仓库目录和 delegated worktree 不会被自动删除。

卸载后建议重启 Codex。
````

## 4. CLI 参数与交互

### 参数

| 参数 | 默认值 | 行为 |
| --- | --- | --- |
| `--dry-run` | `false` | 只扫描和打印计划，不写配置、不删除文件、不调用 remove 命令 |
| `--yes` | `false` | 跳过交互确认 |
| `--keep-state=<value>` | `all` in `--yes` | 控制 `.codex-claude-delegate/` 保留策略 |

`--keep-state` 支持：

- `all`：全部保留。
- `none`：全部删除。
- `jobs,runs,sessions,review-gate` 的任意子集：保留指定项，删除其余项。

### 交互模式

交互模式必须在处理 `.codex-claude-delegate/` 时给出三个选项：

```text
如何处理 .codex-claude-delegate/ 本地状态？
1) 全部删除
2) 全部不删除
3) 由我指定哪些保留
请选择 [1/2/3]:
```

选择 3 时，只允许输入以下标识符：

- `jobs`
- `runs`
- `sessions`
- `review-gate`

输入示例：

```text
sessions,review-gate
```

表示保留 `sessions.json` 和 `review-gate.json`，删除 `jobs/` 和 `runs/`。

### `--yes` 模式

- 自动执行 marketplace remove。
- 自动执行 `codex mcp remove claude_delegate`。
- TOML 中 `auto` / `env_only` 残留自动清理。
- TOML 中 `manual` MCP 配置不删除，只报告。
- `.codex-claude-delegate/` 默认全部保留，除非显式传入 `--keep-state`。
- delegated worktree 只报告，不删除。

## 5. 测试清单

### 单元测试

运行：

```bash
npx vitest run tests/codex-config.test.ts
```

覆盖：

- TOML table key 删除。
- allow-root 路径移除。
- MCP server origin 分类。
- 自动配置删除。
- 手动配置保护。
- 幂等重复调用。

### 脚本测试

运行：

```bash
npx vitest run tests/uninstall-plugin.test.ts
```

覆盖：

- dry-run 零副作用。
- `--yes` 非交互。
- `--keep-state` 三类策略。
- marketplace 检测失败降级。
- `codex mcp remove` 后 TOML 补漏。
- delegated worktree 只提示。

### 最终验证

实现完成后运行：

```bash
npm run typecheck
npm test
npm run build
npm run uninstall:dry-run
```

如果改动影响 plugin bundle，还需要运行：

```bash
npm run build:plugin
npm run check:plugin
```

## 6. 人工验证

以下项目无法仅靠单元测试确认，需要人工验证：

| 编号 | 验证项 |
| --- | --- |
| MV1 | 在干净 Codex 环境中确认 `codex plugin marketplace add "$(pwd)"` 后的真实 marketplace 名称 |
| MV2 | 确认 `codex mcp remove claude_delegate` 是否会修改 `~/.codex/config.toml` |
| MV3 | 交互模式选择“全部删除”后，`.codex-claude-delegate/` 被删除 |
| MV4 | 交互模式选择“全部不删除”后，`.codex-claude-delegate/` 完整保留 |
| MV5 | 交互模式选择“指定保留”后，只删除未保留项 |
| MV6 | `--yes --keep-state=none` 删除全部状态 |
| MV7 | `--yes` 未指定 `--keep-state` 时保留全部状态 |
| MV8 | 非本插件的手动 `[mcp_servers.claude_delegate]` 不会在 `--yes` 下被删除 |
| MV9 | dry-run 不修改 TOML、不删除文件、不执行 remove 命令 |
| MV10 | 卸载后重启 Codex，无 `invalid transport` 等 MCP 启动错误 |
| MV11 | 卸载后重新安装插件，`claude_setup` 可正常运行 |
| MV12 | `.claude/worktrees/codex-delegated-*` 只被报告，不被删除 |

## 7. 风险与回滚

| 风险 | 缓解 |
| --- | --- |
| marketplace 名称不可解析 | 打印原始 `codex plugin marketplace list` 输出，并提示手动 remove |
| `codex mcp remove` 行为随 Codex 版本变化 | 先调用 CLI，再重新扫描 TOML，只做幂等补漏 |
| 手动 MCP 配置被误删 | `origin = "manual"` 时交互确认；`--yes` 模式不删除 |
| 状态目录误删 | 默认保留；交互三选项；dry-run 展示计划 |
| worktree 误删 | 脚本不删除 worktree，只报告 |
| TOML 写入失败 | 每个阶段独立 try/catch，最终汇总失败项和手动修复建议 |

回滚方式：

- marketplace remove 后可用 `codex plugin marketplace add "$(pwd)"` 重新注册。
- allow-root 删除后可重新运行 `claude_setup(cwd=..., configure_allow_root=true)`。
- review-gate hook 删除后可运行 `claude_review_gate enable`。
- `.codex-claude-delegate/` 删除不可恢复，因此必须由用户明确选择。

## 8. 推荐实施顺序

1. 在 `src/codex-config.ts` 添加纯函数和 IO 函数。
2. 为 `tests/codex-config.test.ts` 补齐 TOML 清理测试。
3. 新建 `scripts/uninstall-plugin.mjs`，先实现 `--dry-run`。
4. 实现 marketplace remove 和 `codex mcp remove`。
5. 实现 TOML 补漏清理。
6. 实现 `.codex-claude-delegate/` 三选项处理。
7. 实现 delegated worktree 检测提示。
8. 实现 review-gate hook 清理。
9. 新增 `tests/uninstall-plugin.test.ts`。
10. 更新 `package.json` 和 `README.md`。
11. 跑完整自动验证。
12. 按人工验证清单做真实环境验证。

## 9. 验收标准

该任务完成时应满足：

- `npm run uninstall:dry-run` 可在未 build 的仓库中运行，且无副作用。
- `npm run uninstall` 会先 build，再执行卸载脚本。
- `.codex-claude-delegate/` 处理只有三个选项。
- `--yes` 默认保留 `.codex-claude-delegate/`。
- 自动 MCP 配置能被清理，手动 MCP 配置不会在 `--yes` 下被删除。
- delegated worktree 不会被自动删除。
- 测试覆盖 TOML 清理、脚本参数、dry-run、状态目录策略和手动配置保护。
- `npm run typecheck`、`npm test`、`npm run build` 通过。
