# Execution Plan Guidelines

> 用途：在把 PRD、设计讨论或 bug 修复方案交给 Claude/其他执行者实现前，先按本规范写执行计划。

## 目标

执行计划不是功能清单。执行计划必须把“什么算做对、什么绝不能发生、怎么验证”写清楚，降低执行者把 happy path 做出来但漏掉关键边界的概率。

本仓库的执行计划默认保存到：

```text
docs/superpowers/plans/YYYY-MM-DD-<topic>.md
```

## 必填结构

每份执行计划必须包含以下章节。

### 1. 背景和目标

写清楚：

- 用户问题是什么。
- 当前行为哪里不对。
- 目标行为是什么。
- 本次不做什么。

避免只写“实现 doctor”或“优化安装体验”。要写成可判断的目标，例如：

```text
doctor 必须基于真实 Codex config、Claude CLI、Git 和 allow roots 状态判断是否 ready，不能只因为字段存在就返回 ready。
```

### 2. 文件影响范围

列出每个将被修改或新增的文件，以及职责：

```text
src/cli.ts
- 负责 CLI 参数解析、doctor 输出和 exit code。

src/codex-config.ts
- 负责 Codex TOML 读取、写入、扫描和 allow-root 配置。

tests/cli.test.ts
- 负责 CLI 行为和 doctor 状态判断的隔离测试。
```

如果某个文件不应被修改，也要写明：

```text
dist/ 不允许手工编辑，只能由 build 生成。
```

### 3. 正向验收用例

列出标准成功路径，必须包含输入、预期状态、预期输出或副作用。

示例：

```text
场景：全新用户执行 setup
输入：codex-claude setup --write
预期：
- 创建或更新 ~/.codex/config.toml
- 写入 [mcp_servers.claude_delegate]
- command = "codex-claude"
- enabled_tools 精确包含默认 6 个工具
- exit code = 0
```

### 4. 负向验收用例

负向用例必须和正向用例同等重要。所有涉及配置、状态机、权限、安全、路径、删除、apply 的任务都必须写负向用例。

至少覆盖：

- 缺参数。
- 错误配置。
- 旧配置。
- 字段存在但值错误。
- 缺少必需字段。
- 多余危险能力。
- 路径边界。
- 已有配置时的幂等行为。
- 操作失败时是否有副作用。

示例：

```text
场景：doctor 遇到错误 MCP command
输入配置：
[mcp_servers.claude_delegate]
command = "npx"
enabled_tools = ["claude_setup"]

预期：
- status = "needs_setup"
- ready = false
- mcp_server.ok = false
- warnings 说明 expected "codex-claude"
```

### 5. 禁止事项

写清楚执行者不能做什么。

示例：

```text
- 不允许把 doctor 做成“字段存在检查”。
- 不允许因为 claude --version 成功就报告 Claude auth 已登录。
- 不允许 next_actions 建议非 preview apply。
- 不允许在未得到用户明确确认时调用非 preview claude_apply。
- 不允许手工编辑 dist/。
```

### 6. 测试计划

测试计划必须列出“新增或修改的测试名”和“覆盖点”。不要只写“补测试”。

示例：

```text
tests/cli.test.ts
- doctor reports needs_setup for wrong command
- doctor reports needs_attention when enabled_tools is missing
- doctor reads CODEX_CLAUDE_ALLOW_ROOTS from config file value
- setup --write --allow-root rejects missing path
```

测试要求：

- CLI、文件系统、环境变量、外部命令必须 mock 或隔离。
- 不依赖用户真实 `~/.codex/config.toml`。
- 不依赖真实 Claude CLI。
- 不依赖测试运行机器的全局环境变量。

### 7. 文档一致性检查

计划必须要求执行者同步检查用户文档。每个 README/文档承诺都必须能在代码中找到对应行为。

示例：

```text
README 如果写 doctor 检查 Claude auth，则代码必须真的检查 auth。
如果代码只检查 claude --version，README 只能写 path/version。
```

### 8. 交付要求

执行者完成后必须汇报：

- 修改了哪些文件。
- 每个验收用例对应哪个测试。
- 哪些测试/构建命令已运行。
- 是否有未覆盖风险。
- 是否有文档同步。

不接受只汇报：

```text
All tests pass.
```

必须能回答：

```text
为什么这些测试能证明关键失败场景不会再发生？
```

## Review Checklist

提交执行计划前，计划作者必须自查：

- 是否有明确的正向验收用例。
- 是否有明确的负向验收用例。
- 是否列出禁止事项。
- 是否列出测试名和覆盖点。
- 是否要求隔离真实环境。
- 是否包含文档一致性检查。
- 是否说明哪些文件不应修改。
- 是否避免了 “实现 X”、“补测试”、“处理边界情况” 这类不可验收描述。

## 常见失败模式

### 1. 把结构存在当成行为正确

错误计划：

```text
doctor 输出 JSON，包含 checks 字段。
```

正确计划：

```text
doctor 在 command = "npx" 时必须 status = "needs_setup"，ready = false，并给出 expected "codex-claude" warning。
```

### 2. 只写 happy path

错误计划：

```text
实现 setup --allow-root。
```

正确计划：

```text
setup --write --allow-root 必须在已有 MCP 配置且未 --force 时仍写入 allow root。
--allow-root 缺少路径时必须 exit code = 2。
危险 root 或不存在路径必须 exit code != 0，且不能假装成功。
```

### 3. 文档和代码漂移

错误计划：

```text
更新 README。
```

正确计划：

```text
README 中 doctor 的每一项检查必须和 src/cli.ts 实际检查一致；未实现 auth 检查时不得写 path/version/auth。
```

### 4. 测试依赖真实机器

错误计划：

```text
运行 codex-claude doctor 测试输出。
```

正确计划：

```text
doctor 测试必须 mock execCapture、scanClaudeDelegateConfig、getAllowRoots，不读取真实 Codex config，不调用真实 Claude/Git。
```

## 与其他规范的关系

- `AGENTS.md` 是仓库级 agent 指引。
- `CLAUDE.md` 定义 Think Before Coding、Simplicity First、Surgical Changes、Goal-Driven Execution。
- 本文件专门约束“执行计划怎么写”，尤其是交给 Claude 或其他 agent 执行前的计划质量。
