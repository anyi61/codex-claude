import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
};

function createMockChild(): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

afterEach(() => {
  vi.doUnmock("node:child_process");
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("execStream", () => {
  it("streams stdout chunks and returns close code with accumulated stderr", async () => {
    const child = createMockChild();
    const spawnMock = vi.fn(() => child);
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: spawnMock };
    });

    const { execStream } = await import("../src/guard.js");
    const stdoutChunks: string[] = [];
    const promise = execStream("claude", ["-p", "task"], { cwd: "/repo", timeoutMs: 1234 }, (chunk) => {
      stdoutChunks.push(chunk);
    });

    child.stdout.emit("data", Buffer.from("line one\n"));
    child.stdout.emit("data", Buffer.from("line two\n"));
    child.stderr.emit("data", Buffer.from("warn one\n"));
    child.stderr.emit("data", Buffer.from("warn two\n"));
    child.emit("close", 2);

    await expect(promise).resolves.toEqual({ code: 2, stderr: "warn one\nwarn two\n" });
    expect(stdoutChunks).toEqual(["line one\n", "line two\n"]);
    expect(spawnMock).toHaveBeenCalledWith("claude", ["-p", "task"], {
      cwd: "/repo",
      timeout: 1234,
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("rejects when spawn emits an error", async () => {
    const child = createMockChild();
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: vi.fn(() => child) };
    });

    const { execStream } = await import("../src/guard.js");
    const promise = execStream("missing", [], { cwd: "/repo" });

    child.emit("error", new Error("spawn failed"));

    await expect(promise).rejects.toThrow("spawn failed");
  });

  it("uses the default timeout and handles close with a null code without stdout callback", async () => {
    const child = createMockChild();
    const spawnMock = vi.fn(() => child);
    vi.doMock("node:child_process", async () => {
      const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
      return { ...actual, spawn: spawnMock };
    });

    const { execStream } = await import("../src/guard.js");
    const promise = execStream("claude", ["-p"], { cwd: "/repo" });

    child.stdout.emit("data", Buffer.from("ignored without callback\n"));
    child.stderr.emit("data", Buffer.from("terminated\n"));
    child.emit("close", null);

    await expect(promise).resolves.toEqual({ code: null, stderr: "terminated\n" });
    expect(spawnMock).toHaveBeenCalledWith("claude", ["-p"], {
      cwd: "/repo",
      timeout: 300_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  });
});
