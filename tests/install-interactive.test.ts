import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpHome: string;
let originalStdinTTY: boolean | undefined;
let originalStdoutTTY: boolean | undefined;

beforeEach(() => {
  tmpHome = join(
    tmpdir(),
    `install-interactive-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(join(tmpHome, ".claude"), { recursive: true });
  mkdirSync(join(tmpHome, ".codex"), { recursive: true });
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return { ...actual, homedir: () => tmpHome };
  });

  originalStdinTTY = process.stdin.isTTY;
  originalStdoutTTY = process.stdout.isTTY;
});

afterEach(() => {
  vi.doUnmock("node:os");
  vi.doUnmock("../src/lib/prompt.js");
  Object.defineProperty(process.stdin, "isTTY", {
    value: originalStdinTTY,
    configurable: true,
  });
  Object.defineProperty(process.stdout, "isTTY", {
    value: originalStdoutTTY,
    configurable: true,
  });
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

function setTTY(value: boolean) {
  Object.defineProperty(process.stdin, "isTTY", { value, configurable: true });
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

async function loadInstallHelpers() {
  return await import("../src/commands/install.js");
}

describe("install — TTY runtime resolver (slice-3)", () => {
  it("explicit --runtime → 不弹 prompt, 直接返回", async () => {
    setTTY(true);
    const { _resolveRuntimeInteractive } = await loadInstallHelpers();
    const runtime = await _resolveRuntimeInteractive("claude-code");
    expect(runtime).toBe("claude-code");
  });

  it("非 TTY + 双 runtime + 无 explicit → 走原 resolveRuntime throw", async () => {
    setTTY(false);
    const { _resolveRuntimeInteractive } = await loadInstallHelpers();
    await expect(_resolveRuntimeInteractive(undefined)).rejects.toMatchObject({
      error: "runtime_required",
    });
  });

  it("非 TTY + 单 runtime → 静默用之 (零漂移)", async () => {
    setTTY(false);
    // 删 codex 让只剩 claude-code
    rmSync(join(tmpHome, ".codex"), { recursive: true });
    const { _resolveRuntimeInteractive } = await loadInstallHelpers();
    const runtime = await _resolveRuntimeInteractive(undefined);
    expect(runtime).toBe("claude-code");
  });

  it("TTY + 双 runtime + 用户选 1 → claude-code", async () => {
    setTTY(true);
    vi.doMock("../src/lib/prompt.js", () => ({
      selectFromList: vi.fn().mockResolvedValue(0),
      isInteractive: () => true,
    }));
    const { _resolveRuntimeInteractive } = await loadInstallHelpers();
    const runtime = await _resolveRuntimeInteractive(undefined);
    expect(runtime).toBe("claude-code");
  });

  it("TTY + 双 runtime + 用户 quit → throw runtime_required", async () => {
    setTTY(true);
    vi.doMock("../src/lib/prompt.js", () => ({
      selectFromList: vi.fn().mockResolvedValue("quit"),
      isInteractive: () => true,
    }));
    const { _resolveRuntimeInteractive } = await loadInstallHelpers();
    await expect(_resolveRuntimeInteractive(undefined)).rejects.toMatchObject({
      error: "runtime_required",
    });
  });
});

describe("install — TTY scope resolver (slice-3)", () => {
  it("explicit --scope → 不弹 prompt", async () => {
    setTTY(true);
    const { _resolveScopeInteractive } = await loadInstallHelpers();
    expect(await _resolveScopeInteractive("project")).toBe("project");
  });

  it("非 TTY + 无 explicit → 默认 user (零漂移)", async () => {
    setTTY(false);
    const { _resolveScopeInteractive } = await loadInstallHelpers();
    expect(await _resolveScopeInteractive(undefined)).toBe("user");
  });

  it("TTY + 无 explicit + 选 0 → user", async () => {
    setTTY(true);
    vi.doMock("../src/lib/prompt.js", () => ({
      selectFromList: vi.fn().mockResolvedValue(0),
      isInteractive: () => true,
    }));
    const { _resolveScopeInteractive } = await loadInstallHelpers();
    expect(await _resolveScopeInteractive(undefined)).toBe("user");
  });

  it("TTY + 无 explicit + 选 1 → project", async () => {
    setTTY(true);
    vi.doMock("../src/lib/prompt.js", () => ({
      selectFromList: vi.fn().mockResolvedValue(1),
      isInteractive: () => true,
    }));
    const { _resolveScopeInteractive } = await loadInstallHelpers();
    expect(await _resolveScopeInteractive(undefined)).toBe("project");
  });

  it("TTY + quit → throw scope_invalid", async () => {
    setTTY(true);
    vi.doMock("../src/lib/prompt.js", () => ({
      selectFromList: vi.fn().mockResolvedValue("quit"),
      isInteractive: () => true,
    }));
    const { _resolveScopeInteractive } = await loadInstallHelpers();
    await expect(_resolveScopeInteractive(undefined)).rejects.toMatchObject({
      error: "scope_invalid",
    });
  });
});
