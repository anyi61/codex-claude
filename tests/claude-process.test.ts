import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

type MockChild = EventEmitter & {
  pid: number;
  stdout: EventEmitter;
  stderr: EventEmitter;
};

function createMockChild(pid: number): MockChild {
  const child = new EventEmitter() as MockChild;
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

const baseOpts = {
  prompt: "hello",
  cwd: "/tmp",
  tools: "Read",
  allowedTools: [],
  disallowedTools: [],
  timeoutSec: 30,
  jsonSchema: {},
};

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("claude-process", () => {
  it("parses JSON output on success", async () => {
    const child = createMockChild(1101);
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: vi.fn(() => child) };
    });

    const mod = await import("../src/claude-process.js");
    const promise = mod.spawnClaude(baseOpts);
    child.stdout.emit("data", Buffer.from("{\"session_id\":\"sess-1\",\"structured_output\":{\"status\":\"success\"}}"));
    child.emit("close", 0, null);
    const result = await promise;

    expect(result.session_id).toBe("sess-1");
    expect(result.report).toEqual({ status: "success" });
  });

  it("fails on non-JSON output", async () => {
    const child = createMockChild(1102);
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: vi.fn(() => child) };
    });

    const mod = await import("../src/claude-process.js");
    const promise = mod.spawnClaude(baseOpts);
    child.stdout.emit("data", Buffer.from("plain-text-output"));
    child.emit("close", 0, null);

    await expect(promise).rejects.toThrow("Failed to parse Claude output");
  });

  it("returns a structured no-output error when stdout is empty", async () => {
    const child = createMockChild(1103);
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: vi.fn(() => child) };
    });

    const mod = await import("../src/claude-process.js");
    const promise = mod.spawnClaude(baseOpts);
    child.emit("close", 0, null);

    await expect(promise).rejects.toThrow("Claude produced no output");
  });

  it("returns partial result on non-zero exit when structured_output exists", async () => {
    const child = createMockChild(1104);
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: vi.fn(() => child) };
    });

    const mod = await import("../src/claude-process.js");
    const promise = mod.spawnClaude(baseOpts);
    child.stdout.emit("data", Buffer.from("{\"structured_output\":{\"status\":\"partial\",\"summary\":\"max turns\"}}"));
    child.emit("close", 1, null);
    const result = await promise;

    expect(result.report).toEqual({ status: "partial", summary: "max turns" });
    expect(result.execution.exit_code).toBe(1);
  });

  it("marks timed_out=true when signal is SIGTERM", async () => {
    const child = createMockChild(1105);
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: vi.fn(() => child) };
    });

    const mod = await import("../src/claude-process.js");
    const promise = mod.spawnClaude(baseOpts);
    child.stdout.emit("data", Buffer.from("{\"structured_output\":{\"status\":\"partial\"}}"));
    child.emit("close", null, "SIGTERM");
    const result = await promise;

    expect(result.execution.timed_out).toBe(true);
  });

  it("aborts all active children and only removes the process that closed", async () => {
    const childA = createMockChild(1201);
    const childB = createMockChild(1202);
    const spawnMock = vi.fn()
      .mockReturnValueOnce(childA)
      .mockReturnValueOnce(childB);

    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: spawnMock };
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const mod = await import("../src/claude-process.js");
    const promiseA = mod.spawnClaude(baseOpts);
    const promiseB = mod.spawnClaude(baseOpts);

    expect(mod.abortActiveClaudeRun()).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(1201, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(1202, "SIGTERM");

    childA.stdout.emit("data", Buffer.from("{\"structured_output\":{\"status\":\"success\",\"id\":\"a\"}}"));
    childA.emit("close", 0, null);

    killSpy.mockClear();
    expect(mod.abortActiveClaudeRun()).toBe(true);
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(1202, "SIGTERM");

    childB.stdout.emit("data", Buffer.from("{\"structured_output\":{\"status\":\"success\",\"id\":\"b\"}}"));
    childB.emit("close", 0, null);

    await expect(promiseA).resolves.toMatchObject({ report: { status: "success", id: "a" } });
    await expect(promiseB).resolves.toMatchObject({ report: { status: "success", id: "b" } });
  });

  it("preserves top-level permission_denials when structured_output is present", async () => {
    const child = createMockChild(2001);
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: vi.fn(() => child) };
    });

    const mod = await import("../src/claude-process.js");
    const promise = mod.spawnClaude(baseOpts);
    child.stdout.emit("data", Buffer.from(JSON.stringify({
      permission_denials: [
        { tool_name: "Bash", tool_input: { command: "rm -rf /" } },
      ],
      structured_output: {
        status: "success",
        summary: "Done.",
      },
    })));
    child.emit("close", 0, null);
    const result = await promise;

    expect(result.report).toMatchObject({
      status: "success",
      summary: "Done.",
      permission_denials: [
        { tool_name: "Bash", tool_input: { command: "rm -rf /" } },
      ],
    });
  });

  it("keeps structured_output permission_denials when both levels provide them", async () => {
    const child = createMockChild(2002);
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: vi.fn(() => child) };
    });

    const mod = await import("../src/claude-process.js");
    const promise = mod.spawnClaude(baseOpts);
    child.stdout.emit("data", Buffer.from(JSON.stringify({
      permission_denials: [
        { tool_name: "Bash", tool_input: { command: "top-level" } },
      ],
      structured_output: {
        status: "success",
        summary: "Done.",
        permission_denials: [
          { tool_name: "Write", tool_input: { file_path: "/a" } },
        ],
      },
    })));
    child.emit("close", 0, null);
    const result = await promise;

    // structured_output.permission_denials should NOT be overwritten by top-level
    expect(result.report).toMatchObject({
      status: "success",
      permission_denials: [
        { tool_name: "Write", tool_input: { file_path: "/a" } },
      ],
    });
  });

  it("does not add permission_denials to report when top-level is absent", async () => {
    const child = createMockChild(2003);
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: vi.fn(() => child) };
    });

    const mod = await import("../src/claude-process.js");
    const promise = mod.spawnClaude(baseOpts);
    child.stdout.emit("data", Buffer.from(JSON.stringify({
      structured_output: {
        status: "success",
        summary: "Done.",
      },
    })));
    child.emit("close", 0, null);
    const result = await promise;

    expect(result.report.permission_denials).toBeUndefined();
  });
});
