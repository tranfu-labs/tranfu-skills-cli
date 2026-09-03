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
  mkdirSync(join(tmpHome, ".agents"), { recursive: true });
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
    rmSync(join(tmpHome, ".agents"), { recursive: true });
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
    const r = await _resolveScopeInteractive("project", "claude-code");
    expect(r.scope).toEqual({ kind: "project" });
    expect(r.detectedHint).toBeUndefined();
  });

  it("非 TTY + 无 explicit (claude-code) → 默认 user (零漂移)", async () => {
    setTTY(false);
    const { _resolveScopeInteractive } = await loadInstallHelpers();
    const r = await _resolveScopeInteractive(undefined, "claude-code");
    expect(r.scope).toEqual({ kind: "user" });
  });

  it("TTY + 无 explicit (claude-code) + 选 0 → user", async () => {
    setTTY(true);
    vi.doMock("../src/lib/prompt.js", () => ({
      selectFromList: vi.fn().mockResolvedValue(0),
      isInteractive: () => true,
    }));
    const { _resolveScopeInteractive } = await loadInstallHelpers();
    const r = await _resolveScopeInteractive(undefined, "claude-code");
    expect(r.scope).toEqual({ kind: "user" });
  });

  it("TTY + 无 explicit (claude-code) + 选 1 → project", async () => {
    setTTY(true);
    vi.doMock("../src/lib/prompt.js", () => ({
      selectFromList: vi.fn().mockResolvedValue(1),
      isInteractive: () => true,
    }));
    const { _resolveScopeInteractive } = await loadInstallHelpers();
    const r = await _resolveScopeInteractive(undefined, "claude-code");
    expect(r.scope).toEqual({ kind: "project" });
  });

  it("TTY + quit (claude-code) → throw scope_invalid", async () => {
    setTTY(true);
    vi.doMock("../src/lib/prompt.js", () => ({
      selectFromList: vi.fn().mockResolvedValue("quit"),
      isInteractive: () => true,
    }));
    const { _resolveScopeInteractive } = await loadInstallHelpers();
    await expect(
      _resolveScopeInteractive(undefined, "claude-code")
    ).rejects.toMatchObject({
      error: "scope_invalid",
    });
  });
});

describe("install — hermes scope resolver (detectActiveProfile fallback)", () => {
  it("hermes + 无 explicit + 有 active profile (env) → profile:<name> + 提示", async () => {
    setTTY(true);
    process.env.HERMES_HOME = `${tmpHome}/.hermes/profiles/coder`;
    const { _resolveScopeInteractive } = await loadInstallHelpers();
    const r = await _resolveScopeInteractive(undefined, "hermes");
    expect(r.scope).toEqual({ kind: "profile", name: "coder" });
    expect(r.detectedHint).toContain("detected hermes profile: coder");
    delete process.env.HERMES_HOME;
  });

  it("hermes + 无 explicit + 无 active (env=空 + hermes 二进制不在) → user + 默认提示", async () => {
    setTTY(false);
    delete process.env.HERMES_HOME;
    // hermes 二进制不在 PATH (CI 默认就这样), execSync 内会失败回到 null
    const { _resolveScopeInteractive } = await loadInstallHelpers();
    const r = await _resolveScopeInteractive(undefined, "hermes");
    expect(r.scope).toEqual({ kind: "user" });
    expect(r.detectedHint).toContain("no active hermes profile");
  });

  it("hermes + explicit profile:coder → 直接用", async () => {
    setTTY(false);
    const { _resolveScopeInteractive } = await loadInstallHelpers();
    const r = await _resolveScopeInteractive("profile:coder", "hermes");
    expect(r.scope).toEqual({ kind: "profile", name: "coder" });
    expect(r.detectedHint).toBeUndefined();
  });
});
