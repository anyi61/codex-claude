import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const pluginRoot = path.join(repoRoot, "plugins", "codex-claude-delegate");
const mcpConfigPath = path.join(pluginRoot, ".mcp.json");

function fail(message) {
  console.error(`check:plugin failed: ${message}`);
  process.exit(1);
}

if (!existsSync(mcpConfigPath)) {
  fail(`missing MCP config at ${mcpConfigPath}`);
}

const mcpConfig = JSON.parse(readFileSync(mcpConfigPath, "utf8"));
const serverConfig = mcpConfig?.mcpServers?.claude_delegate;
const serverArg = serverConfig?.args?.[0];

if (typeof serverArg !== "string" || !serverArg.length) {
  fail("plugins/codex-claude-delegate/.mcp.json missing claude_delegate.args[0]");
}

const serverPath = path.resolve(pluginRoot, serverArg.replace("${CLAUDE_PLUGIN_ROOT}", pluginRoot));
const jobRunnerPath = path.join(path.dirname(serverPath), "job-runner.js");

if (!existsSync(serverPath)) {
  fail(`server file not found: ${serverPath}`);
}

if (!existsSync(jobRunnerPath)) {
  fail(`background job runner file not found: ${jobRunnerPath}`);
}

try {
  execFileSync("git", ["check-ignore", "-q", serverPath], { cwd: repoRoot, stdio: "ignore" });
  fail(`server file is ignored by git: ${serverPath}`);
} catch (error) {
  if (error && typeof error === "object" && "status" in error && error.status === 1) {
    // not ignored, expected
  } else {
    fail(`unable to run git check-ignore for ${serverPath}`);
  }
}

try {
  execFileSync("git", ["check-ignore", "-q", jobRunnerPath], { cwd: repoRoot, stdio: "ignore" });
  fail(`background job runner file is ignored by git: ${jobRunnerPath}`);
} catch (error) {
  if (error && typeof error === "object" && "status" in error && error.status === 1) {
    // not ignored, expected
  } else {
    fail(`unable to run git check-ignore for ${jobRunnerPath}`);
  }
}

try {
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import(${JSON.stringify(pathToFileURL(serverPath).href)}).then(()=>process.exit(0)).catch((err)=>{console.error(err);process.exit(1);});`
    ],
    { cwd: repoRoot, stdio: "pipe" }
  );
} catch (error) {
  const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
  fail(`unable to load plugin server with node: ${stderr.trim() || "unknown error"}`);
}

try {
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import(${JSON.stringify(pathToFileURL(jobRunnerPath).href)}).then(()=>process.exit(0)).catch((err)=>{console.error(err);process.exit(1);});`
    ],
    { cwd: repoRoot, stdio: "pipe" }
  );
} catch (error) {
  const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
  fail(`unable to load plugin background job runner with node: ${stderr.trim() || "unknown error"}`);
}

// ---- Tool definition consistency checks ----

function getToolBlock(content, toolName) {
  const nameIdx = content.indexOf(`name: "${toolName}"`);
  if (nameIdx < 0) return null;

  let braceCount = 0;
  let openBrace = nameIdx;
  for (let i = nameIdx; i >= 0; i--) {
    if (content[i] === "}") {
      braceCount++;
    } else if (content[i] === "{") {
      braceCount--;
      if (braceCount < 0) {
        openBrace = i;
        break;
      }
    }
  }
  if (braceCount >= 0) return null;

  braceCount = 0;
  let endIdx = openBrace;
  for (let i = openBrace; i < content.length; i++) {
    if (content[i] === "{") {
      braceCount++;
    } else if (content[i] === "}") {
      braceCount--;
    }
    if (braceCount === 0) {
      endIdx = i;
      break;
    }
  }

  return content.slice(openBrace, endIdx + 1);
}

function getPropertiesBlock(toolBlock) {
  const propsKeyIdx = toolBlock.indexOf("properties:");
  if (propsKeyIdx < 0) return null;

  const openIdx = toolBlock.indexOf("{", propsKeyIdx);
  if (openIdx < 0) return null;

  let depth = 0;
  let closeIdx = openIdx;
  for (let i = openIdx; i < toolBlock.length; i++) {
    if (toolBlock[i] === "{") {
      depth++;
    } else if (toolBlock[i] === "}") {
      depth--;
    }
    if (depth === 0) {
      closeIdx = i;
      break;
    }
  }

  return toolBlock.slice(openIdx + 1, closeIdx);
}

const serverContent = readFileSync(serverPath, "utf8");
const toolSchemaChecks = [
  {
    name: "claude_query",
    requires: ["instruction_files"],
    forbids: ["background"],
  },
  {
    name: "claude_review",
    requires: ["instruction_files"],
    forbids: ["background"],
  },
  {
    name: "claude_implement",
    requires: [],
    forbids: ["background"],
  },
];

for (const check of toolSchemaChecks) {
  const block = getToolBlock(serverContent, check.name);
  if (!block) {
    fail(`tool definition "${check.name}" not found in bundled server.js`);
  }

  const propsBlock = getPropertiesBlock(block);
  if (!propsBlock) {
    fail(`tool "${check.name}" is missing inputSchema.properties section`);
  }

  for (const requiredProp of check.requires) {
    const pattern = new RegExp(`(?:${requiredProp}|"${requiredProp}"):`);
    if (!pattern.test(propsBlock)) {
      fail(`tool "${check.name}" inputSchema missing required property "${requiredProp}"`);
    }
  }

  for (const forbiddenProp of check.forbids) {
    const pattern = new RegExp(`(?:${forbiddenProp}|"${forbiddenProp}"):`);
    if (pattern.test(propsBlock)) {
      fail(`tool "${check.name}" inputSchema should not expose property "${forbiddenProp}"`);
    }
  }
}

const expectedHookManifestPath = path.join(pluginRoot, "hooks", "hooks.json");

try {
  const setupRaw = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      const { handleToolCall } = await import(${JSON.stringify(pathToFileURL(serverPath).href)});
      const result = await handleToolCall("claude_setup", { cwd: ${JSON.stringify(repoRoot)} });
      const text = result?.content?.[0]?.text;
      if (typeof text !== "string") {
        throw new Error("claude_setup did not return JSON text content");
      }
      const payload = JSON.parse(text);
      process.stdout.write(JSON.stringify(payload));
      `
    ],
    {
      cwd: repoRoot,
      stdio: "pipe",
      env: {
        ...process.env,
        CODEX_CLAUDE_ALLOW_ROOTS: repoRoot,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
      },
    }
  );
  const setup = JSON.parse(String(setupRaw));
  const reviewGate = setup?.review_gate;
  if (!reviewGate || typeof reviewGate !== "object") {
    fail("claude_setup response missing review_gate object");
  }
  if (reviewGate.hook_manifest_path !== expectedHookManifestPath) {
    fail(
      `claude_setup reported unexpected hook_manifest_path: ${reviewGate.hook_manifest_path} (expected ${expectedHookManifestPath})`
    );
  }
  if (reviewGate.hook_installed !== true) {
    fail("claude_setup reported review_gate.hook_installed !== true");
  }
} catch (error) {
  if (error instanceof SyntaxError) {
    fail(`unable to parse claude_setup response: ${error.message}`);
  }
  const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
  const message = error instanceof Error ? error.message : String(error);
  fail(`claude_setup runtime validation failed: ${stderr.trim() || message}`);
}

console.log("check:plugin ok");
