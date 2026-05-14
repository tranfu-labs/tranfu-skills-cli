import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TfsError } from "../src/types.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(
    tmpdir(),
    `uninstall-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(join(tmpHome, ".claude", "skills"), { recursive: true });
  mkdirSync(join(tmpHome, ".codex", "skills"), { recursive: true });
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return { ...actual, homedir: () => tmpHome };
  });
});

afterEach(() => {
  vi.doUnmock("node:os");
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

function seedSkill(name: string, frontmatter: string) {
  const dir = join(tmpHome, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n# body\n`);
  return dir;
}

const intactFm = `name: foo
description: foo
installed_by: tranfu-skills
installed_version: abc123
installed_at: 2026-05-14
installed_source: own`;

const partialFm = `name: bar
description: bar
installed_by: tranfu-skills
installed_at: 2026-05-14`;

const handmadeFm = `name: my-handmade
description: I wrote this`;

async function loadUninstall() {
  return await import("../src/commands/uninstall.js");
}

function captureExit() {
  return vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
}

describe("uninstall — happy paths", () => {
  it("intact 戳 → rm + 输出 ✓ uninstalled", async () => {
    const dir = seedSkill("foo", intactFm);
    const { uninstallCommand } = await loadUninstall();
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await uninstallCommand("foo", { scope: "user", runtime: "claude-code" });

    expect(existsSync(dir)).toBe(false);
    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("✓ uninstalled foo");
    expect(out).toContain(dir);
  });

  it("partial 戳 → rm (partial 也是 tranfu-skills 装的)", async () => {
    const dir = seedSkill("bar", partialFm);
    const { uninstallCommand } = await loadUninstall();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await uninstallCommand("bar", { scope: "user", runtime: "claude-code" });

    expect(existsSync(dir)).toBe(false);
  });
});

describe("uninstall — registry-driven (no flags)", () => {
  function seedCodex(name: string, fm: string) {
    const dir = join(tmpHome, ".codex", "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\n${fm}\n---\n# body\n`);
    return dir;
  }

  it("无 flag + registry 找到 1 处 → 删 + ✓ uninstalled", async () => {
    const dir = seedSkill("foo", intactFm);
    const { uninstallCommand } = await loadUninstall();
    // 预先 read 触发 bootstrap, 让 registry 知道 foo
    const reg = await import("../src/lib/registry.js");
    reg.readRegistry();

    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await uninstallCommand("foo", {});

    expect(existsSync(dir)).toBe(false);
    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("✓ uninstalled foo");
  });

  it("无 flag + registry 找到 0 处 → skill_not_found, hint 提到 tfs installed", async () => {
    const { uninstallCommand } = await loadUninstall();
    const reg = await import("../src/lib/registry.js");
    reg.readRegistry();

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const exitSpy = captureExit();

    await expect(uninstallCommand("nonexistent", {})).rejects.toThrow(
      "process.exit called"
    );

    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("skill_not_found");
    expect(parsed.hint).toContain("tfs installed");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("无 flag + registry 找到 2 处 + 非 TTY → ambiguous_target + 列出位置", async () => {
    const dirA = seedSkill("shared", intactFm);
    const dirB = seedCodex(
      "shared",
      intactFm.replace("name: foo", "name: shared")
    );
    const { uninstallCommand } = await loadUninstall();
    const reg = await import("../src/lib/registry.js");
    reg.readRegistry();

    // 模拟非 TTY
    const origTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const exitSpy = captureExit();

    try {
      await expect(uninstallCommand("shared", {})).rejects.toThrow(
        "process.exit called"
      );
      const parsed = JSON.parse(
        stderrSpy.mock.calls.map((c) => c[0]).join("")
      ) as TfsError;
      expect(parsed.error).toBe("ambiguous_target");
      expect(parsed.message).toContain("shared");
      expect(parsed.message).toContain(dirA);
      expect(parsed.message).toContain(dirB);
      expect(parsed.hint).toContain("--runtime");
      expect(exitSpy).toHaveBeenCalledWith(1);
      // 没删
      expect(existsSync(dirA)).toBe(true);
      expect(existsSync(dirB)).toBe(true);
    } finally {
      Object.defineProperty(process.stdout, "isTTY", {
        value: origTTY,
        configurable: true,
      });
    }
  });

  it("显式 --runtime + --scope → 跳 registry 走原 r1 单 scope 行为 (零漂移)", async () => {
    const dir = seedSkill("foo", intactFm);
    const { uninstallCommand } = await loadUninstall();
    // 此处特意不预 bootstrap registry — 测显式路径不依赖 registry
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await uninstallCommand("foo", { runtime: "claude-code", scope: "user" });

    expect(existsSync(dir)).toBe(false);
    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("✓ uninstalled foo");
  });
});

describe("uninstall — error cases", () => {
  it("目录不存在 → skill_not_found + hint 提到 tfs installed", async () => {
    const { uninstallCommand } = await loadUninstall();
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const exitSpy = captureExit();

    await expect(
      uninstallCommand("nonexistent", {
        scope: "user",
        runtime: "claude-code",
      })
    ).rejects.toThrow("process.exit called");

    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("skill_not_found");
    expect(parsed.hint).toContain("tfs installed");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("目录存在但无戳 (handmade) → skill_not_found + 不删 + hint 提到 手装", async () => {
    const dir = seedSkill("my-handmade", handmadeFm);
    const stalePath = join(dir, "user-data.txt");
    writeFileSync(stalePath, "user content");

    const { uninstallCommand } = await loadUninstall();
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    captureExit();

    await expect(
      uninstallCommand("my-handmade", {
        scope: "user",
        runtime: "claude-code",
      })
    ).rejects.toThrow("process.exit called");

    // 关键: handmade skill 不被删
    expect(existsSync(dir)).toBe(true);
    expect(existsSync(stalePath)).toBe(true);

    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("skill_not_found");
    expect(parsed.message).toContain("无 installed_by 戳");
    expect(parsed.hint).toContain("手装");
  });

  it("--runtime invalid → exit 1 runtime_invalid", async () => {
    const { uninstallCommand } = await loadUninstall();
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    captureExit();
    await expect(
      uninstallCommand("foo", { scope: "user", runtime: "vim" })
    ).rejects.toThrow("process.exit called");
    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("runtime_invalid");
  });

  it("--scope invalid → exit 1 scope_invalid", async () => {
    const { uninstallCommand } = await loadUninstall();
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    captureExit();
    await expect(
      uninstallCommand("foo", { scope: "global", runtime: "claude-code" })
    ).rejects.toThrow("process.exit called");
    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("scope_invalid");
  });
});

describe("uninstall — install+uninstall 往返 (用 installed 命令)", () => {
  it("装一个 skill → installed 看到 → uninstall → installed 看不到", async () => {
    seedSkill("foo", intactFm);
    const { uninstallCommand } = await loadUninstall();
    const { installedCommand } = await import("../src/commands/installed.js");

    // 先 installed 确认存在
    let stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await installedCommand({ runtime: "claude-code", json: true });
    let parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""));
    expect(parsed.installed).toHaveLength(1);
    stdoutSpy.mockRestore();

    // uninstall
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await uninstallCommand("foo", { scope: "user", runtime: "claude-code" });
    stdoutSpy.mockRestore();

    // 再 installed 确认消失
    stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await installedCommand({ runtime: "claude-code", json: true });
    parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""));
    expect(parsed.installed).toHaveLength(0);
  });
});
