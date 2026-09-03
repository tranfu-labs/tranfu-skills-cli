import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpHome: string;
let originalStdoutTTY: boolean | undefined;

beforeEach(() => {
  tmpHome = join(
    tmpdir(),
    `uninstall-interactive-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(join(tmpHome, ".claude", "skills"), { recursive: true });
  mkdirSync(join(tmpHome, ".agents", "skills"), { recursive: true });
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return { ...actual, homedir: () => tmpHome };
  });

  originalStdoutTTY = process.stdout.isTTY;
});

afterEach(() => {
  vi.doUnmock("node:os");
  vi.doUnmock("../src/lib/prompt.js");
  Object.defineProperty(process.stdout, "isTTY", {
    value: originalStdoutTTY,
    configurable: true,
  });
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

function setStdoutTTY(value: boolean) {
  Object.defineProperty(process.stdout, "isTTY", { value, configurable: true });
}

const intactFm = `name: foo
description: foo
installed_by: tranfu-skills
installed_version: abc123
installed_at: 2026-05-14
installed_source: own`;

function seedClaude(name: string, fm: string) {
  const dir = join(tmpHome, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${fm}\n---\n# body\n`);
  return dir;
}

function seedCodex(name: string, fm: string) {
  const dir = join(tmpHome, ".agents", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${fm}\n---\n# body\n`);
  return dir;
}

describe("uninstall — TTY 1 处 + confirm", () => {
  it("TTY + 1 处 + confirm Y → 删", async () => {
    setStdoutTTY(true);
    const dir = seedClaude("foo", intactFm);
    vi.doMock("../src/lib/prompt.js", () => ({
      confirm: vi.fn().mockResolvedValue(true),
      multiSelectFromList: vi.fn(),
      selectFromList: vi.fn(),
      isInteractive: () => true,
    }));
    const { uninstallCommand } = await import("../src/commands/uninstall.js");
    const reg = await import("../src/lib/registry.js");
    reg.readRegistry();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await uninstallCommand("foo", {});
    expect(existsSync(dir)).toBe(false);
  });

  it("TTY + 1 处 + confirm N → 保留 + cancelled", async () => {
    setStdoutTTY(true);
    const dir = seedClaude("foo", intactFm);
    vi.doMock("../src/lib/prompt.js", () => ({
      confirm: vi.fn().mockResolvedValue(false),
      multiSelectFromList: vi.fn(),
      selectFromList: vi.fn(),
      isInteractive: () => true,
    }));
    const { uninstallCommand } = await import("../src/commands/uninstall.js");
    const reg = await import("../src/lib/registry.js");
    reg.readRegistry();
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await uninstallCommand("foo", {});
    expect(existsSync(dir)).toBe(true);
    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("cancelled");
  });
});

describe("uninstall — TTY 多处 + multiselect + confirm", () => {
  it("多处 + multiselect 选 [0] + confirm Y → 只删第 1 处", async () => {
    setStdoutTTY(true);
    const dirA = seedClaude("shared", intactFm);
    const dirB = seedCodex("shared", intactFm.replace("name: foo", "name: shared"));
    vi.doMock("../src/lib/prompt.js", () => ({
      multiSelectFromList: vi.fn().mockResolvedValue([0]),
      confirm: vi.fn().mockResolvedValue(true),
      selectFromList: vi.fn(),
      isInteractive: () => true,
    }));
    const { uninstallCommand } = await import("../src/commands/uninstall.js");
    const reg = await import("../src/lib/registry.js");
    reg.readRegistry();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await uninstallCommand("shared", {});
    expect(existsSync(dirA)).toBe(false);
    expect(existsSync(dirB)).toBe(true);
  });

  it("多处 + multiselect 全选 + confirm Y → 删两处", async () => {
    setStdoutTTY(true);
    const dirA = seedClaude("shared", intactFm);
    const dirB = seedCodex("shared", intactFm.replace("name: foo", "name: shared"));
    vi.doMock("../src/lib/prompt.js", () => ({
      multiSelectFromList: vi.fn().mockResolvedValue([0, 1]),
      confirm: vi.fn().mockResolvedValue(true),
      selectFromList: vi.fn(),
      isInteractive: () => true,
    }));
    const { uninstallCommand } = await import("../src/commands/uninstall.js");
    const reg = await import("../src/lib/registry.js");
    reg.readRegistry();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await uninstallCommand("shared", {});
    expect(existsSync(dirA)).toBe(false);
    expect(existsSync(dirB)).toBe(false);
  });

  it("多处 + multiselect 选完 + confirm N → 不删", async () => {
    setStdoutTTY(true);
    const dirA = seedClaude("shared", intactFm);
    const dirB = seedCodex("shared", intactFm.replace("name: foo", "name: shared"));
    vi.doMock("../src/lib/prompt.js", () => ({
      multiSelectFromList: vi.fn().mockResolvedValue([0, 1]),
      confirm: vi.fn().mockResolvedValue(false),
      selectFromList: vi.fn(),
      isInteractive: () => true,
    }));
    const { uninstallCommand } = await import("../src/commands/uninstall.js");
    const reg = await import("../src/lib/registry.js");
    reg.readRegistry();
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await uninstallCommand("shared", {});
    expect(existsSync(dirA)).toBe(true);
    expect(existsSync(dirB)).toBe(true);
    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("cancelled");
  });

  it("多处 + multiselect quit → 不删 + cancelled", async () => {
    setStdoutTTY(true);
    const dirA = seedClaude("shared", intactFm);
    const dirB = seedCodex("shared", intactFm.replace("name: foo", "name: shared"));
    vi.doMock("../src/lib/prompt.js", () => ({
      multiSelectFromList: vi.fn().mockResolvedValue("quit"),
      confirm: vi.fn(),
      selectFromList: vi.fn(),
      isInteractive: () => true,
    }));
    const { uninstallCommand } = await import("../src/commands/uninstall.js");
    const reg = await import("../src/lib/registry.js");
    reg.readRegistry();
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await uninstallCommand("shared", {});
    expect(existsSync(dirA)).toBe(true);
    expect(existsSync(dirB)).toBe(true);
    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("cancelled");
  });
});
