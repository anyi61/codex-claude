# 项目审查：优先级问题与修复方案

日期：2026-05-07

范围：全仓库审查，涵盖用户体验、上手引导、编码规范、可扩展性、安全性、测试及插件打包。

审查中的验证条件：

- `npm run typecheck` 通过
- `npm test` 通过：10 个测试文件，122 个测试
- `npm run check:plugin` 通过

## 审查方法

本次审查基于：

- 静态代码阅读：MCP 工具注册、Zod 输入校验、作业/运行状态处理、apply 流程、guard 逻辑、插件元数据、hooks 及 README 工作流
- 对照检查文档中的工具调用与所需的工具 schema 是否一致
- 运行上述验证命令
- 使用 `claude_task(mode="review")` 针对本报告进行二次审查

未执行的操作：

- 未进行干净的 Codex 插件安装/卸载测试
- 未在现有测试套件和审查之外执行真实的 Claude Code 委托
- 未生成正式覆盖率报告

说明：

- 有直接代码/文档证据的项视为已确认问题
- 兼容性和安全边界项属于从代码和文档推断的设计风险，除非明确标记为可复现故障
- P4 项使用更短格式，属于打磨或随手清理项，非主要修复工作

---

## P0：修复正确性风险

### 1. 后台运行日志与前台 apply 使用不同的状态根目录

**证据**

- `LOG_DIR` 和 `SESSION_DIR` 在 `src/claude-cli.ts` 中从模块加载时的 `process.cwd()` 推导
- 插件 MCP 配置在插件根目录以 `cwd: "."` 启动 server
- 后台作业 runner 以目标仓库为 `cwd` 启动
- `claude_apply` 后续通过扫描当前进程的 `LOG_DIR` 查找 implement 日志

**影响**

后台 implement 作业可以将运行日志写入目标仓库，而前台 `claude_apply` 扫描的是插件/server 状态目录。Apply 可能丢失 implement 运行的基础 commit、观测文件、范围检查和资源限制元数据。

**建议修复**

- 使后台作业状态、运行日志和会话存储按已解析的目标 `cwd` 区分工作区，而非按 MCP 进程 cwd
- 在作业记录中存储 implement 的 `run_id` 和 `worktree_path`，让 `claude_result` 返回精确的 apply 参数
- 修改 `claude_apply`，使其优先通过相关的 job/run 记录解析 implement 元数据，而非扫描进程全局日志目录
- 保留用于测试/调试的环境变量覆盖，但使默认行为按工作区确定

**风险 / 回归考量**

- 现有运行日志可能已位于旧的进程 cwd 位置。修复方案应在过渡期内读取旧日志，或在仅有旧元数据时返回明确提示
- 用户可能在一个 Codex 会话中操作多个仓库。工作区分隔的状态必须能隔离不同仓库，同时不使跨仓库的 `claude_workspace_status` 或清理流程产生混淆
- 当前依赖进程 cwd 状态目录的测试需要显式指定测试状态根目录

**建议验证**

- 添加集成测试：将进程 cwd 设为假想插件根目录后导入 server，为一个独立仓库排队/运行 implement 作业，然后调用前台 `runClaudeApply(preview=true)` 并验证能查找到观测元数据
- 添加回归测试：implement 修改了 `README.md` 和 `tests/foo.test.ts`；预览结果必须包含两者

### 2. Apply 回退仅处理 `src/`

**证据**

当未找到 implement 日志/基础 commit 时，`runClaudeApply` 回退到 pathspec `src/`。

**影响**

对测试、文档、配置、包元数据、迁移脚本或根目录文件的合法变更可能被静默忽略，或报告为"在工作树中未找到变更文件"。这与委托实现工作的正常预期相冲突。

**建议修复**

- 在缺少 implement 元数据时执行失败关闭：返回可操作错误，告知调用方使用 `claude_result`、`claude_run_inspect`，或在支持后传入显式的 `run_id/job_id`
- 将旧版回退视为独立的兼容性路径，不作为 P0 修复的默认行为。若保留，必须设为主动启用或在结果中明确标明
- 除非来自显式的严格范围，绝不静默缩小 apply 范围

**风险 / 回归考量**

- 失败关闭行为可能阻止当前能 apply 手动创建的旧版 worktree 的用户。错误信息应说明支持的恢复路径
- 移除静默的 `src/` 回退可能暴露之前被隐藏的失败。这对正确性有利，但发布说明应加以说明

**建议验证**

- 为 apply 预览/落地涉及 `README.md`、`tests/` 和 `package.json` 变更的场景添加测试
- 添加测试：implement 元数据缺失，确认响应明确且可操作

---

## P1：修复产品工作流与 API 契约缺口

### 3. `instruction_files` 在直接 query/review 工具中仅部分实现

**证据**

- TypeScript 接口和 prompt 构建器支持 `ClaudeQueryInput` 和 `ClaudeReviewInput` 的 `instruction_files`
- Zod schema 和 MCP 工具定义未对 `claude_query` 或 `claude_review` 暴露 `instruction_files`
- Server 处理函数未将 `instruction_files` 传递到直接的 `claude_query` 和 `claude_review`

**影响**

遵循插件技能或内部 API 的用户可以传入 `instruction_files` 且不会收到验证错误，但 Claude 从未收到这些文件。这是 API 契约缺口，且直接工具体验令人困惑。这不是 P0 正确性问题，因为高层 `claude_task` 路径能正确传递 instruction_files。

**建议修复**

- 将 `instruction_files` 添加到 `claudeQueryInputSchema` 和 `claudeReviewInputSchema`
- 将该字段添加到 MCP 工具定义
- 使用 `validateFilesWithinCwd` 验证 instruction_files
- 在 handler 中传递该字段到 `startBackgroundQuery` 和 `startBackgroundReview`
- 添加 schema/工具定义契约测试，防止此类偏差再次出现

**风险 / 回归考量**

- 添加可选字段应向后兼容，但 schema 和 MCP 工具定义必须对默认值和验证行为一致
- 直接工具的指纹可能因 `instruction_files` 成为排队作业 payload 的一部分而改变；应验证去重行为

**建议验证**

- 单元测试：直接调用 `handleToolCall("claude_query", { instruction_files: [...] })`
- 单元测试：直接调用 `handleToolCall("claude_review", { instruction_files: [...] })`
- Prompt 构建器测试：确认文件列表出现在生成的 prompt 中

### 4. 直接工具始终排队后台作业，尽管接受 `background` 参数

**证据**

`claude_query`、`claude_review` 和 `claude_implement` 的 handler 强制 `background: true`。

**影响**

这可能是有意为之，但公开字段暗示前台执行可用。API 形状与行为不一致，这对直接工具调用者是 API 契约缺口。

**建议修复**

- 从直接工具 schema 和文档中移除 `background`，或使其真正支持 `background=false`
- 如果所有执行工具都应始终排队，明确记录这一点并移除令人困惑的参数

**风险 / 回归考量**

- 移除公开字段对已传入该字段的调用者是破坏性 API 变更，即使它当前被忽略
- 支持 `background=false` 将重新引入前台执行语义和超时行为，当前设计可能有意避免

**建议验证**

- 更新 server 测试以断言所选行为

### 5. README 示例不可直接复制运行

**证据**

最小示例中 `claude_job_wait` 和 `claude_result` 缺少必需的 `cwd`。

**影响**

新用户可以成功运行 `claude_task`，然后在下一个文档步骤失败。这是首个上手体验的高摩擦点。

**建议修复**

- 在每个工具调用示例中包含 `cwd`
- 使用一致的占位符，例如 `"/path/to/your/repo"`
- 添加完整的首次运行记录，包含 `job_id` 的复用

**建议验证**

- 添加轻量级文档测试或脚本，检查 README 示例是否包含默认工作流工具的必填字段

### 6. 快速开始未强调 `configure_allow_root`

**证据**

`claude_setup` 可以通过 `configure_allow_root=true` 自行配置允许根目录，但 README 将手动配置作为主要路径展示。

**影响**

位于 `~/projects`、`~/work` 或 `~/codex-claude` 之外的用户会较早遇到 allow-root 错误，且需要理解配置内部细节。

**建议修复**

- 在快速开始中说明：如果 setup 报告在允许根目录之外且仓库可信，重新运行 `claude_setup(cwd="...", configure_allow_root=true)`
- 添加警示：扩展允许根目录会授予插件在该路径下操作的权限；用户不应添加宽泛或不受信任的目录
- 将手动 TOML 编辑移到自我配置路径之后
- 使 setup 返回的 `next_actions` 与 README 完全一致

**风险 / 回归考量**

- 过度强调 `configure_allow_root=true` 可能鼓励用户添加宽泛的允许根目录。文档应将其作为受信任仓库的便利功能，而非通用绕过手段

**建议验证**

- 为超范围错误和 `next_actions` 添加 setup 测试
- 在 `~/Documents` 或其他非默认路径下手动测试

### 7. README 结构过于工具中心化

**证据**

README 过早暴露全部 18 个工具，且有空的 `## 功能` 章节。

**影响**

项目读起来像 API 转储而非产品工作流。首次用户需要知道走哪条路径，而非记住每个工具。

**建议修复**

- 填充 `## 功能` 章节，提供简洁列表，例如：
  - 从 Codex 将读取/审查/写入任务委托给 Claude Code
  - 在隔离 git worktree 中运行写入任务
  - 轮询和恢复后台作业
  - 预览/将委托变更落地回主工作区
  - 跟踪审查门状态和清理旧 worktree
- 将使用说明拆分为三个主要工作流：
  - 只读提问
  - 审查/审计
  - 写入/落地/清理
- 将高级/调试工具移至后面的参考章节

**建议验证**

- 请新用户仅依据 README 完成一次读取任务和一次写入任务；记录他们在哪里停顿

---

## P2：加强安全、可靠性和验证

### 8. 安全章节夸大了隔离边界

**证据**

README 将工具限制列为安全保障，而 implement 模式允许 `npx`、`node`、`python`、`cp`、`mv` 等宽泛命令。

**影响**

维护者和用户可能假设系统提供比实际更强的隔离。当前设计是实用的，但并非沙箱。

**建议修复**

- 将 README `安全` 重命名为 `安全边界与限制`
- 明确说明 Claude 在 git worktree 中运行并受工具限制，而非完整的操作系统沙箱
- 记录值得注意的允许命令类别及其必要性
- 考虑收窄高风险命令，或使其可按模式配置

**建议验证**

- 为 `buildImplementArgs` 添加测试，使允许/禁止工具的策略是经过考量的
- 在变更允许工具时添加文档检查项

### 9. 审查门 hook 可能查找错误的工作区

**证据**

`plugins/codex-claude-delegate/hooks/review-gate-stop.mjs` 使用 `process.env.PWD || process.cwd()` 来定位 `.codex-claude-delegate/review-gate.json`。

**影响**

如果 Codex 从插件目录或其他 cwd 调用 hooks，审查门静默无作为。

**建议修复**

- 优先使用 hook 负载或 Codex 提供的工作区路径（如可用）
- 如果无法解析工作区，发出诊断负载而非静默退出
- 考虑将审查门状态写入与 jobs/runs 相同的按工作区隔离的状态层

**建议验证**

- 在 `PWD` 分别设置为仓库和插件根目录时，对 hook 进行单元测试
- 在 implement/apply 流程后手动测试 stop-hook 行为

### 10. 缺乏外部依赖兼容性策略

**证据**

插件依赖于多个不稳定或由外部控制的层面：

- Codex 插件市场行为
- Codex MCP 插件加载和 hook 调用语义
- Claude Code CLI 标志，如 `--permission-mode`、`--allowedTools`、`--disallowedTools`、`--json-schema`、会话标志和 auth/status 输出
- Git worktree 行为和本地进程环境行为

README 记录了前置条件，但未提供明确的兼容性矩阵、最低支持版本或针对这些外部接口的契约测试策略。

**影响**

Codex 插件加载或 Claude Code CLI 参数语义的变更可能在不修改此仓库源码的情况下破坏项目。用户在升级外部工具后可能遇到工具启动失败、静默 hook 失败或错误的 Claude 调用。

**建议修复**

- 记录已知可用的 Codex 和 Claude Code CLI 版本或最低版本假设
- 在 README 中添加兼容性章节
- 保持 `npm run check:plugin` 作为本地插件运行时检查，并随时间推移扩展以验证最关键假设：工具加载、hook 路径解析和已安装 Claude 时的 CLI 标志可用性
- 在外部 CLI/插件假设变化时添加变更日志说明

**建议验证**

- 在发布前运行干净的插件安装测试
- 为维护者添加轻量级兼容性检查清单
- 在可行时，为 CLI 参数构建和 hook 路径假设添加测试

### 11. README 卸载市场名称可能错误（未确认）

**证据**

`README.md` 使用 `codex plugin marketplace add "$(pwd)"` 安装，但使用 `codex plugin marketplace remove codex-claude-local` 卸载。本次审查未运行干净的安装/卸载测试，因此这仍是一个未确认的文档风险。

**影响**

如果文档中的名称与 Codex 创建的市场条目不匹配，用户可能无法按照 README 移除本地市场。

**建议修复**

- 确认 Codex 为本地路径创建的实际市场名称
- 如果名称依赖于用户/环境，在移除前先记录 `codex plugin marketplace list`
- 使用 Codex 支持的相同名称或基于路径的移除命令

**建议验证**

- 从干净的 Codex 配置手动安装和卸载，然后用观察到的确切流程更新 README

### 12. 环境清理策略应被监控和记录

**证据**

`sanitizeEnv()` 宽泛地剥离 token/API-key 类变量，同时保留 `PATH`、`HOME` 等常见进程变量，以及不匹配密钥名称的代理相关环境。当前报告未复现具体故障，因此这是兼容性和策略风险，而非确认的 bug。

**影响**

某些合法的 Claude/代理/认证设置可能需要的环境变量被剥离或脱敏。同时，保留的非密文变量仍描述了用户的本地环境。这一权衡应明确说明，让用户理解其边界：这是环境最小化，而非完整的安全沙箱。

**建议修复**

- 将当前策略记录为环境最小化，而非沙箱化
- 保持诊断中区分"因安全原因被剥离"与"父进程中缺失"，使其在故障排除文档中可见
- 在用户报告具体的 Claude/代理/认证故障，或受支持的 Claude 安装需要特定环境变量时，重新审视该策略
- 如果故障被确认，为所需的 Claude 环境变量添加文档化的允许列表，或引入严格/兼容模式

**建议验证**

- 为代理/认证环境变量行为添加测试
- 使用 `CLAUDE_BIN`、代理变量和正常 Claude 认证进行手动测试

### 13. 生命周期级别风险的测试充分性不明确

**证据**

测试套件通过，但本次审查未生成覆盖率报告或证明完整任务生命周期的端到端覆盖。最重要的风险涉及跨多个组件的交互：排队作业、作业 runner、运行日志、worktree 元数据、结果查找、apply 预览、apply 落地和清理。

当前测试在单元级行为和选定的集成类流程上表现良好，但许多 server 测试 mock 了 CLI 边界，多个 CLI 测试直接设置了状态目录。这对快速回归测试有用，但可能遗漏 server 进程 cwd、目标仓库 cwd 和后台 runner cwd 不同的插件运行时不匹配。

**影响**

围绕工作区范围状态和 apply 元数据的 P0 修复可能在测试仅覆盖隔离单元时出现回归。通过的单元测试可能无法捕捉插件根进程 cwd 与目标仓库作业 cwd 之间的不匹配。

**建议修复**

- 添加有针对性的生命周期集成测试：任务 -> 等待/结果 -> 预览 -> 落地 -> 清理
- 添加故障路径测试：元数据缺失、worktree 创建失败、主工作区脏、git 冲突和过期作业
- 将覆盖率百分比视为辅助数据而非目标。目标是处于风险中的跨组件工作流的显式覆盖

**建议验证**

- 在 P0 状态修复之前或同时，至少添加一项插件根与目标仓库的集成测试
- 在生命周期测试存在后考虑添加覆盖率命令

---

## P3：提升可维护性和可扩展性

### 14. 工具 schema 定义重复且偏离

**证据**

输入字段在 TypeScript 接口、Zod schema 和手动 MCP JSON schema 中分别定义。`instruction_files` 在这些层之间发生了偏离。

**影响**

添加工具字段容易出错，且可能产生不可见的特性缺口。

**建议修复**

- 选择单一真相源，推荐 Zod schema
- 从 Zod 生成 MCP JSON schema，或添加契约测试，比较 Zod 和 `TOOL_DEFINITIONS` 之间的预期字段集
- 在可行时将 TypeScript 接口从 Zod 派生

**建议验证**

- 添加测试：检查每个用于公开 API 的 Zod 字段是否出现在 MCP 工具定义中

### 15. 状态模型分散在 jobs、runs、sessions、worktrees 和 review gate 中

**证据**

Jobs 在一个存储中，运行日志在另一个中，sessions 在另一个中，worktrees 在 `.claude/worktrees` 下，review gate 在 `.codex-claude-delegate/review-gate.json` 中。

**影响**

`claude_result`、`claude_workspace_status` 和 `claude_apply` 等功能必须通过扫描和推断来拼接状态，使恢复流程脆弱。

**建议修复**

- 将完整的工作区状态服务视为长期方向，而非首要修复
- 首先，在关键路径上添加显式的查询/链接函数：
  - 按 job id 查找运行元数据
  - 按 worktree 路径查找运行元数据
- 关键路径稳定后，考虑提供带如下 API 的工作区状态服务：
  - `getWorkspaceStateDir(cwd)`
  - `recordRun`
  - `recordJob`
  - `linkJobRun`
  - `findRunForWorktree`
  - `getReviewGateState`
- 显式存储关联关系：job id、run id、worktree 名称/路径、基础 commit、生命周期

**建议验证**

- 为任务 -> 等待 -> 结果 -> 预览 -> 落地 -> 清理生命周期添加端到端测试

---

## P4：文档打磨和随手清理

### 16. 部分代码看起来像调试遗留物

**证据**

`supportsWorktree()` 返回 `out.length > 0 || true`，在命令成功时等价于 `true`。

**影响**

行为可能正确，但表达式看起来像偶然产物，降低了维护者的信心。

**建议修复**

- 替换为 `await execCapture(...); return true;`
- 添加注释说明命令成功即为能力检查

**建议验证**

- 现有 guard 测试应继续通过

### 17. 高级工具启用说明不充分

**证据**

`README.md` 说"在 `enabled_tools` 中添加需要的工具名即可"，未说明具体位置或提供完整示例。

**建议修复**

- 如果高级工具确实被 Codex/插件配置隐藏，显示确切的配置文件和 TOML 片段
- 如果工具当前未被实现隐藏，将措辞改为"高级工具不建议日常使用"而非"默认禁用"

### 18. 故障排查应将错误映射到后续命令

**建议修复**

对每个常见错误，包含接下来应使用的确切命令：

- 不在允许根目录内 -> `claude_setup(cwd="...", configure_allow_root=true)`
- 作业活跃 -> `claude_job_wait(cwd="...", job_id="...")`
- Apply 被拒绝 -> `claude_apply(cwd="...", worktree_path="...", preview=true)` 并检查状态
- 缺少 server runtime -> `npm run build:plugin && npm run check:plugin`

---

## 建议实施顺序

1. 修复工作区范围的状态/日志解析，并添加生命周期集成测试。
   理由：这是 apply 正确性方面风险最高的问题，测试应能复现插件根与目标仓库的状态不匹配。

2. 修复元数据缺失时的 apply 行为；移除静默的 `src/` 缩小，为非 `src/` 变更和元数据缺失添加测试。
   理由：状态查找确定为确定性后，apply 应显式失败而非落地部分或误导的子集。

3. 添加 schema/工具定义契约测试。
   理由：这锁定了公开 MCP 表面，在扩展直接工具字段前防止另一轮 schema 偏离。

4. 为直接 query/review 工具添加并传递 `instruction_files`。
   理由：这是可见的 API 契约缺口，应在新的契约测试覆盖下修复。

5. 解决直接工具的 `background` 契约。
   理由：调用者不应看到被忽略或强制覆盖的参数而缺乏文档说明。

6. 使 README 示例可复制运行，并改进受信任 allow-root 的上手引导。
   理由：这是最快的首次体验摩擦修复，且应与工具响应保持一致。

7. 修复审查门 hook 的工作区解析，并明确安全边界、环境策略和外部依赖假设。
   理由：Hook 路径解析是剩余的 P2 实施风险；文档工作塑造用户期望和发布检查。

8. 添加初始生命周期测试未覆盖的故障路径测试。
   理由：元数据缺失、脏工作区、git 冲突、过期作业和 worktree 失败是与快乐路径不同的独立风险。

9. 添加显式的状态链接/查询辅助函数；在关键路径稳定前推迟完整工作区状态服务。
   理由：辅助函数减少扫描/推断，无需立即引入广泛的状态系统重写。

10. 从干净的配置验证插件安装/卸载文档，然后打磨 README 结构、高级工具文档、故障排查和 P4 代码清理。
    理由：卸载问题未经手动测试即未确认；打磨和随手清理应跟随行为检查之后。
