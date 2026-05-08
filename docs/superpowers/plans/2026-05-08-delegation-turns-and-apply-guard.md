# 委托回合上限与落地防护实现计划

> **给智能体工作者的提示：** 必需子技能：使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 逐任务执行本计划。步骤使用复选框（`- [ ]`）语法进行跟踪。

**目标：** 使默认的 `claude_task` 无法设置回合上限，并使非预览（non-preview）的 `claude_apply` 在没有用户明确批准的情况下无法执行。

**架构：** 将两个问题视为工具合约（tool-contract）的缺陷，而非 Claude 执行的缺陷。从默认的 `claude_task` 入口点移除 `max_turns`，使模型无法在该处自行发明该参数；只在高级/调试工具中保留回合上限。在服务端添加 apply 的批准校验，从工作流建议中移除直接 apply，并更新插件文档和测试，使模型行为与服务行为保持一致。

**技术栈：** TypeScript MCP 服务器、Zod 模式、Vitest、Claude Code CLI 参数构造、插件 Markdown 技能、README 文档。

---

## 问题描述

### 症状 1：用户未指定时 `turn` / `max_turns` 仍可被使用

观察到的行为：
- 即使未明确要求回合上限，`claude_task` 调用也可能包含 `max_turns`。
- 这违反了既定规则：默认委托不应有显式回合上限；`max_turns` 仅在用户显式请求时才允许使用。

当前证据：
- `claude_task` 在 `src/server.ts` 中将 `max_turns` 暴露为普通的可选 MCP 输入字段，并在 `claudeTaskInputSchema` 中接受该参数。
- 当前描述仅说明 `Maximum Claude turns for the delegated task`。
- `runClaudeTask()` 将 `input.max_turns` 转发到 query/review/implement 负载中。
- `buildClaudeArgs()` 仅在 `opts.maxTurns !== undefined` 时发出 `--max-turns`，因此底层实现的默认行为是正确的。

根因：
- 默认实现是正确的，但策略在工具合约中的编码强度不够。
- 由于 `max_turns` 作为可选参数暴露给模型，模型可能出于成本、速度或感知边界性的考虑而主动选择使用它。
- 服务端无法区分用户显式指定的 `max_turns` 与模型自行发明的 `max_turns`。

### 症状 2：Claude 写任务的结果可以在未获用户明确许可的情况下被落地

观察到的行为：
- 在 `claude_task(mode="write")` 之后，工作流可以从结果检查直接进入 `claude_apply(cleanup=true)`，无需单独的用户批准步骤。
- 这违反了既定规则：非预览的 apply 会修改主工作区，必须要求用户明确批准。

当前证据：
- `claude_apply` 在 `src/server.ts` 中被列为默认工具。
- `claude_apply` 模式允许非预览的 apply 仅需 `cwd` 和 `worktree_path`；`preview` 为可选且默认为 false。
- `runClaudeApply()` 在 `preview` 不为 true 时直接在主工作区中复制/删除文件。
- `buildNextActions()` 目前对已完成的 implement 运行同时返回预览操作和非预览的 apply 操作。
- `plugins/codex-claude-delegate/skills/claude-delegate.md` 中说明先预览，审查后再 apply，但并未要求用户明确确认。

根因：
- Apply 的安全性依赖于智能体的工作流纪律，而非服务端的强制措施。
- 该工具没有 `confirmed_by_user` 或等效的防护字段。
- 工具建议中包含一个可直接调用的破坏性操作，增加了模型执行该操作的概率。

## 设计原则

- 无隐藏上限：默认的 `claude_task` 不得暴露或接受 `max_turns`；如果用户需要回合上限，请使用高级/调试工具 `claude_query`、`claude_review` 或 `claude_implement`。
- 预览默认安全：`claude_apply(preview=true)` 无需批准即可使用，因为它不修改文件。
- 主工作区写入需要明确批准：除非工具输入中明确表示已获批准，否则任何非预览的 apply 都必须被拒绝。
- 矛盾的 apply 输入将被拒绝：`preview=true` 不能与 `cleanup=true` 同时使用。
- 在可行的情况下避免歧义的魔法字符串，但由于 MCP 工具无法暴露可靠的用户意图来源，因此接受一个务实的确认字段。
- 保持改动范围最小：不重新设计作业队列、工作树创建或结果观察。

## 文件结构

- 修改 `src/schema.ts`
  - 为 `ClaudeApplyInput` 和 `claudeApplyInputSchema` 添加批准字段。
  - 从 `ClaudeTaskInput` 和 `claudeTaskInputSchema` 中移除 `max_turns`。
  - 添加模式精化（refinement），拒绝 `preview=true` 与 `cleanup=true` 同时使用。

- 修改 `src/server.ts`
  - 从默认的 MCP 输入模式中移除 `claude_task.max_turns`。
  - 更新 `claude_task`、高级/调试工具回合上限和 `claude_apply` 的 MCP 描述。
  - 暴露新的 apply 批准字段。

- 修改 `src/claude-cli.ts`
  - 停止从 `runClaudeTask()` 转发 `input.max_turns`，因为该字段在默认入口点已不再存在。
  - 拒绝未获明确批准的非预览 apply。
  - 从自动下一步操作中移除非预览的 `claude_apply`。
  - 修改下一步操作的提示文案：先预览，然后向用户请求批准后再 apply。

- 修改 `plugins/codex-claude-delegate/skills/claude-delegate.md`
  - 声明 `claude_task` 不接受 `max_turns`；显式回合上限需使用高级/调试工具。
  - 声明除非用户明确批准应用预览的 diff，否则不得调用非预览的 `claude_apply`。

- 修改 `plugins/codex-claude-delegate/skills/claude-review.md`
  - 澄清审查结果不等于 apply 批准。

- 修改 `README.md`
  - 以面向用户的语言记录两条安全规则。

- 修改 `docs/development-overview.md`
  - 记录工具合约策略，以便未来维护者不会重新引入仅靠软性规则约束的做法。

- 修改 `tests/schema.test.ts`
  - 验证 apply 批准模式的行为。
  - 验证 `claude_task` 不再接受 `max_turns`。
  - 验证 `preview=true` 加 `cleanup=true` 被拒绝。

- 修改 `tests/server.test.ts`
  - 验证 MCP 路由保留批准字段。
  - 验证 `claude_task` 工具元数据不暴露 `max_turns`。

- 修改 `tests/claude-cli.test.ts`
  - 验证未经批准的非预览 apply 被拒绝且不会修改文件。
  - 验证 `confirmed_by_user: false` 的非预览 apply 被拒绝且不会修改文件。
  - 验证预览仍然无需批准即可工作。
  - 验证下一步操作不包含直接的非预览 apply。
  - 验证 `claude_task` 默认路径在排队负载中不存储 `max_turns`。

## 提议的 API 变更

### `claude_apply`

添加一个可选字段：

```ts
confirmed_by_user?: boolean;
```

规则：
- `preview: true` 忽略 `confirmed_by_user`；预览保持只读且允许。
- `preview: true` 与 `cleanup: true` 同时使用会被拒绝，因为预览绝不能移除工作树。
- `preview !== true` 要求 `confirmed_by_user === true`。
- 如果缺失或为 false，返回结构化的拒绝响应，不执行任何文件修改。
- `cleanup: true` 与 `preview !== true` 同时使用时也要求 `confirmed_by_user === true`，因为清理操作跟随 apply 执行。

示例——已批准的调用：

```text
claude_apply(
  cwd="/path/to/repo",
  worktree_path=".claude/worktrees/codex-delegated-abc123",
  cleanup=true,
  confirmed_by_user=true
)
```

拒绝消息应清晰明确：

```text
Non-preview claude_apply requires confirmed_by_user=true after the user explicitly approves applying the previewed diff.
```

### `claude_task.max_turns`

从默认的 `claude_task` 入口点移除该字段。

本次变更后允许的操作：

```text
claude_query(max_turns=...)
claude_review(max_turns=...)
claude_implement(max_turns=...)
```

理由：
- `claude_task` 是默认的高级工具。它应在模型主动调用时保持安全。
- 观察到的 bug 是由于 `max_turns` 在默认工具中可供模型使用所致。
- MCP 无法证明一个可选标量值是用户请求的还是模型自行发明的。
- 高级/调试工具可以保留 `max_turns`，因为它们是有意用于更底层控制的。

兼容性影响：
- 现有的向 `claude_task` 传递 `max_turns` 的调用者必须改用 `claude_query`、`claude_review` 或 `claude_implement`。
- 这是可接受的，因为默认入口点的安全不变性比保留一个不安全的便利性更重要。

## 实现任务

### 任务 1：从默认的 `claude_task` 中移除 `max_turns`

**文件：**
- 修改：`src/schema.ts`
- 修改：`src/server.ts`
- 测试：`tests/schema.test.ts`
- 测试：`tests/server.test.ts`

- [ ] **步骤 1：编写模式/服务器测试，证明 `claude_task` 不再接受或暴露 `max_turns`**

在 `tests/schema.test.ts` 中添加断言：

```ts
const parsed = claudeTaskInputSchema.safeParse({
  cwd: "/repo",
  task: "write docs",
  mode: "write",
  max_turns: 2,
});
expect(parsed.success).toBe(true);
if (!parsed.success) throw new Error("unexpected parse failure");
expect(parsed.data).not.toHaveProperty("max_turns");
```

在 `tests/server.test.ts` 中检查工具模式的地方添加服务器元数据断言：

```ts
const taskTool = tools.find((tool) => tool.name === "claude_task");
expect(taskTool?.inputSchema.properties).not.toHaveProperty("max_turns");
```

运行：

```bash
npx vitest run tests/schema.test.ts tests/server.test.ts
```

预期：失败，直到模式和 MCP 元数据被修改。

- [ ] **步骤 2：从 TypeScript/Zod 和服务器元数据中移除该字段**

在 `src/schema.ts` 中，从 `ClaudeTaskInput` 中移除：

```ts
max_turns?: number;
```

从 `claudeTaskInputSchema` 中移除：

```ts
max_turns: maxTurnsSchema.optional(),
```

在 `src/server.ts` 中，仅从 `claude_task` 工具模式中移除 `max_turns` 属性。在 `claude_query`、`claude_review` 和 `claude_implement` 上保留 `max_turns`，并在描述中说明省略表示无显式回合上限。

- [ ] **步骤 3：停止从 `runClaudeTask()` 转发 `max_turns`**

在 `src/claude-cli.ts` 中，从 `runClaudeTask()` 负载中移除三处 `max_turns: input.max_turns` 行：

```ts
const queued = await startBackgroundQuery({
  cwd: input.cwd,
  task: input.task,
  instruction_files: instructionFiles,
  timeout_sec: input.timeout_sec,
});
```

对 `runClaudeTask()` 中 review 和 implement 的负载构建也做同样的移除。

- [ ] **步骤 4：验证默认路由不存储回合上限**

运行：

```bash
npx vitest run tests/claude-cli.test.ts -t "claude_task"
```

预期：现有测试继续显示排队的 `claude_task` 负载中没有 `max_turns`。

### 任务 2：添加 apply 批准模式与服务器元数据

**文件：**
- 修改：`src/schema.ts`
- 修改：`src/server.ts`
- 测试：`tests/schema.test.ts`
- 测试：`tests/server.test.ts`

- [ ] **步骤 1：编写 `confirmed_by_user` 以及预览/清理冲突的模式测试**

在 `tests/schema.test.ts` 的现有 apply 模式测试中添加断言：

```ts
expect(claudeApplyInputSchema.safeParse({
  cwd: "/repo",
  worktree_path: ".claude/worktrees/codex-delegated-x",
  preview: true,
}).success).toBe(true);

expect(claudeApplyInputSchema.safeParse({
  cwd: "/repo",
  worktree_path: ".claude/worktrees/codex-delegated-x",
  cleanup: true,
  confirmed_by_user: true,
}).success).toBe(true);

expect(claudeApplyInputSchema.safeParse({
  cwd: "/repo",
  worktree_path: ".claude/worktrees/codex-delegated-x",
  preview: true,
  cleanup: true,
}).success).toBe(false);
```

运行：

```bash
npx vitest run tests/schema.test.ts
```

预期：失败，直到模式字段存在。

- [ ] **步骤 2：添加 TypeScript 字段和 Zod 字段**

在 `src/schema.ts` 中，更新 `ClaudeApplyInput`：

```ts
export interface ClaudeApplyInput {
  cwd: string;
  worktree_path: string;
  cleanup?: boolean;
  preview?: boolean;
  background?: boolean;
  confirmed_by_user?: boolean;
}
```

更新 `claudeApplyInputSchema`：

```ts
export const claudeApplyInputSchema = z.object({
  cwd: cwdSchema,
  worktree_path: z.string().trim().min(1, "worktree_path is required"),
  cleanup: z.boolean().optional(),
  preview: z.boolean().optional(),
  background: z.boolean().optional(),
  confirmed_by_user: z.boolean().optional(),
}).refine((value) => !(value.preview === true && value.cleanup === true), {
  message: "preview=true cannot be combined with cleanup=true",
  path: ["cleanup"],
});
```

- [ ] **步骤 3：暴露该字段并强化描述**

将 `claude_apply` 的描述修改为：

```ts
"Default tool. Preview a delegated worktree diff, or apply it only after explicit user approval. Non-preview apply requires confirmed_by_user=true."
```

添加属性：

```ts
confirmed_by_user: {
  type: "boolean",
  description: "Required for non-preview apply after the user explicitly approves applying the previewed diff. Not required for preview=true.",
},
```

- [ ] **步骤 4：验证目标模式/服务器测试**

运行：

```bash
npx vitest run tests/schema.test.ts tests/server.test.ts
```

预期：通过——在路由期望中按需更新 `confirmed_by_user` 后。

### 任务 3：在实现中强制非预览 apply 的批准

**文件：**
- 修改：`src/claude-cli.ts`
- 测试：`tests/claude-cli.test.ts`

- [ ] **步骤 1：编写一个失败的测试，验证未批准的非预览 apply 在变更前被拒绝**

在 `tests/claude-cli.test.ts` 中现有 apply 测试附近添加测试：

```ts
it("refuses non-preview apply without explicit user approval", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "codex-apply-approval-"));
  cleanupPaths.push(root);
  const repo = path.join(root, "repo");
  const stateDir = path.join(root, ".codex-claude-delegate");
  const logDir = path.join(stateDir, "runs");
  await mkdir(logDir, { recursive: true });
  sh(root, "git", "init", repo);
  sh(repo, "git", "config", "user.name", "Test User");
  sh(repo, "git", "config", "user.email", "test@example.com");
  await writeFile(path.join(repo, "README.md"), "# original\n");
  sh(repo, "git", "add", ".");
  sh(repo, "git", "commit", "-m", "init");

  const worktreeRel = ".claude/worktrees/codex-delegated-approval";
  sh(repo, "git", "worktree", "add", "--detach", worktreeRel, "HEAD");
  const worktree = path.join(repo, worktreeRel);
  const baseCommit = sh(worktree, "git", "rev-parse", "HEAD");
  await writeFile(path.join(worktree, "README.md"), "# changed\n");

  process.env.CODEX_CLAUDE_RUN_LOG_DIR = logDir;
  await writeFile(path.join(logDir, "approval-run.json"), JSON.stringify({
    type: "implement",
    observed: {
      worktree_path: worktreeRel,
      base_commit: baseCommit,
      changed_files: ["README.md"],
    },
  }, null, 2));

  vi.resetModules();
  const reloaded = await import("../src/claude-cli.js");
  const result = await reloaded.runClaudeApply({
    cwd: repo,
    worktree_path: worktreeRel,
  }, "apply-without-approval");

  expect(result.error).toContain("confirmed_by_user=true");
  expect(result.applied_files).toEqual([]);
  expect(await readFile(path.join(repo, "README.md"), "utf8")).toBe("# original\n");
});
```

运行：

```bash
npx vitest run tests/claude-cli.test.ts -t "refuses non-preview apply without explicit user approval"
```

预期：失败，因为当前代码会直接 apply。

- [ ] **步骤 2：在变更前添加批准防护**

在 `runClaudeApply()` 中，在路径验证之后、差异计算之前是可以接受的，但必须在任何变更操作之前。在工作树存在性检查之后，在函数开始处附近添加：

```ts
if (input.preview !== true && input.confirmed_by_user !== true) {
  return finish({
    applied_files: [],
    diff_stat: "",
    cleanup_performed: false,
    conflicts: [],
    error: "Non-preview claude_apply requires confirmed_by_user=true after the user explicitly approves applying the previewed diff.",
    preview: false,
    planned_changes: [],
  });
}
```

- [ ] **步骤 3：添加/更新一个正向的已批准 apply 测试**

在现有测试期望实际执行 apply 的地方，传入：

```ts
confirmed_by_user: true,
```

同时添加一个显式 false 的负面案例：

```ts
const explicitFalse = await reloaded.runClaudeApply({
  cwd: repo,
  worktree_path: worktreeRel,
  confirmed_by_user: false,
}, "apply-with-false-approval");

expect(explicitFalse.error).toContain("confirmed_by_user=true");
expect(explicitFalse.applied_files).toEqual([]);
expect(await readFile(path.join(repo, "README.md"), "utf8")).toBe("# original\n");
```

这应仅添加到那些有意验证文件变更的测试中。

- [ ] **步骤 4：验证 apply 测试**

运行：

```bash
npx vitest run tests/claude-cli.test.ts -t "apply"
```

预期：apply 预览测试无需批准即可通过；变更测试仅在设置了 `confirmed_by_user: true` 时通过。

### 任务 4：从自动下一步操作中移除直接 apply

**文件：**
- 修改：`src/claude-cli.ts`
- 测试：`tests/claude-cli.test.ts`

- [ ] **步骤 1：编写/更新下一步操作的测试**

更新现有的 implement 结果下一步操作测试，使其期望预览但不期望直接的非预览 apply：

```ts
const applyActions = result.next_actions.filter((action) => action.tool === "claude_apply");
expect(applyActions).toHaveLength(1);
expect(applyActions[0]?.args).toMatchObject({
  cwd: repo,
  worktree_path: ".claude/worktrees/codex-delegated-123",
  preview: true,
});
expect(applyActions[0]?.reason).toContain("Ask the user for approval");
```

运行：

```bash
npx vitest run tests/claude-cli.test.ts -t "next_actions"
```

预期：失败，直到 `buildNextActions()` 被修改。

- [ ] **步骤 2：移除非预览 apply 建议**

在 `buildNextActions()` 中，仅保留预览操作并更改原因：

```ts
actions.push({
  tool: "claude_apply",
  reason: "Preview the delegated worktree diff before modifying the main workspace. After preview, ask the user for explicit approval before any non-preview apply.",
  args: { cwd: input.cwd, worktree_path: worktreePath, preview: true },
});
```

删除当前建议的第二个操作：

```ts
args: { cwd: input.cwd, worktree_path: worktreePath, cleanup: true }
```

- [ ] **步骤 3：验证下一步操作测试**

运行：

```bash
npx vitest run tests/claude-cli.test.ts -t "next_actions|claude_result"
```

预期：通过——在期望的数组更新后。

### 任务 5：强化插件技能和文档

**文件：**
- 修改：`plugins/codex-claude-delegate/skills/claude-delegate.md`
- 修改：`plugins/codex-claude-delegate/skills/claude-review.md`
- 修改：`README.md`
- 修改：`docs/development-overview.md`

- [ ] **步骤 1：更新委托技能策略**

在 `plugins/codex-claude-delegate/skills/claude-delegate.md` 中，在第一段后添加：

```markdown
`claude_task` does not accept `max_turns`. If the user explicitly asks for a turn cap, use the appropriate Advanced / Debug tool (`claude_query`, `claude_review`, or `claude_implement`) instead of the default high-level entrypoint.

For write tasks, non-preview `claude_apply` modifies the main workspace. Always run `claude_apply preview=true` first, show or summarize the planned diff, and wait for explicit user approval before calling non-preview `claude_apply` with `confirmed_by_user=true`.
```

更新默认工作流步骤：

```markdown
5. Preview with `claude_apply preview=true`.
6. Ask the user whether to apply the previewed diff.
7. Only after explicit approval, apply with `claude_apply cleanup=true confirmed_by_user=true`.
8. Use `claude_cleanup` for leftover delegated worktrees.
```

- [ ] **步骤 2：更新审查技能策略**

在 `plugins/codex-claude-delegate/skills/claude-review.md` 中添加：

```markdown
A review result is not apply approval. After reviewing a delegated worktree, ask the user before any non-preview `claude_apply` call.
```

- [ ] **步骤 3：更新 README 使用流程**

在写流程中，将操作更改为：

```text
→ claude_apply(cwd="...", worktree_path=".claude/worktrees/codex-delegated-xxx", preview=true)  # 预览
→ 用户确认后：claude_apply(cwd="...", worktree_path=".claude/worktrees/codex-delegated-xxx", cleanup=true, confirmed_by_user=true) # 落地+清理
```

添加重要说明：

```markdown
- **回合上限：** `claude_task` 不接受 `max_turns`。只有用户明确要求限制 Claude 回合数时，才改用高级工具 `claude_query` / `claude_review` / `claude_implement` 并设置 `max_turns`。
- **落地确认：** `preview=true` 只预览，不修改主工作区；非 preview 的 `claude_apply` 必须在用户确认后传 `confirmed_by_user=true`。
```

- [ ] **步骤 4：更新开发概述**

添加一个简短的维护说明：

```markdown
Tool-contract safety rules:

- `claude_task` must not expose `max_turns`; explicit turn caps belong only to Advanced / Debug tools.
- `claude_apply` is preview-first. Non-preview apply is a main-workspace write and must require `confirmed_by_user=true`.
- `confirmed_by_user` is a pragmatic service-side guard against accidental non-preview apply. It is model-supplied and not cryptographic proof of human intent, so docs and agent instructions must still require explicit user approval before setting it.
- Workflow `next_actions` must not suggest direct non-preview apply.
```

### 任务 6：构建插件运行时并验证所有检查

**文件：**
- 生成物：`plugins/codex-claude-delegate/server/server.js`
- 生成物：`plugins/codex-claude-delegate/server/job-runner.js`（如果构建输出改变了它）

- [ ] **步骤 1：运行目标测试**

```bash
npx vitest run tests/schema.test.ts tests/server.test.ts tests/claude-cli.test.ts
```

预期：通过。

- [ ] **步骤 2：运行类型检查**

```bash
npm run typecheck
```

预期：通过。

- [ ] **步骤 3：运行全部测试**

```bash
npm test
```

预期：通过。

- [ ] **步骤 4：构建运行时**

```bash
npm run build
```

预期：通过，并在适用时更新生成的运行时。

- [ ] **步骤 5：必要时检查生成的插件**

如果此仓库的构建流程需要刷新插件包，运行：

```bash
npm run build:plugin
npm run check:plugin
```

预期：通过。如果 `build:plugin` 不可用，则记录跳过，因为脚本不存在。

## 验收标准

- `claude_task` 模式和 MCP 元数据不暴露 `max_turns`。
- 现有默认的 `claude_task` 测试证明排队的负载中不包含 `max_turns`。
- `claude_apply(preview=true)` 无需批准即可工作，且从不修改主工作区。
- `claude_apply(preview=true, cleanup=true)` 因矛盾而被拒绝。
- `claude_apply(preview!==true)` 返回结构化拒绝，除非 `confirmed_by_user === true`。
- `claude_apply(preview!==true, confirmed_by_user=false)` 返回与缺少批准时相同的拒绝。
- `buildNextActions()` 仅建议预览，不直接建议 apply。
- 技能文档和 README 均声明审查不等于 apply 批准。
- 开发文档记录 `confirmed_by_user` 是防止意外执行的服务端防护措施，而非人类意图的加密证明。
- 完整验证通过：目标测试、`npm run typecheck`、`npm test` 和 `npm run build`。

## 自我审查

规范覆盖范围：
- 症状、根因、解决方案和实现计划均已记录。
- `max_turns` 和未授权的 apply 均已处理。
- 计划包含代码、测试、文档和生成的运行时验证。

占位符扫描：
- 没有剩余的 `TBD`、`TODO` 或未指定的实现步骤。

类型一致性：
- 新字段在 TypeScript、Zod 模式、服务器模式、文档和测试中一致地命名为 `confirmed_by_user`。

## 供 Claude 审查的问题

1. 将 `max_turns` 从 `claude_task` 移除后，回合上限问题是否得到了充分解决，同时保留了高级/调试工具的显式使用？
2. 如果文档明确声明 `confirmed_by_user` 是自述的而非人类意图的加密证明，那么将其作为务实的服务端防护措施是否可接受？
3. 是否有任何缺失的测试可能导致任一回归问题重现？
