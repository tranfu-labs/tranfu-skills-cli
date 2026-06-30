import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpHome: string;
const origEnv = { ...process.env };

beforeEach(() => {
  tmpHome = join(
    tmpdir(),
    `hermes-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(join(tmpHome, ".hermes"), { recursive: true });
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return { ...actual, homedir: () => tmpHome };
  });
  // 干净 env: 测试自己控制 HERMES_HOME
  delete process.env.HERMES_HOME;
});

afterEach(() => {
  vi.doUnmock("node:os");
  process.env = { ...origEnv };
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

async function loadHermes() {
  return await import("../src/lib/hermes.js");
}

describe("PROFILE_NAME_RE", () => {
  it("接受合法名 (字母/数字/_/-)", async () => {
    const { PROFILE_NAME_RE } = await loadHermes();
    expect(PROFILE_NAME_RE.test("coder")).toBe(true);
    expect(PROFILE_NAME_RE.test("my-bot_2")).toBe(true);
    expect(PROFILE_NAME_RE.test("A1")).toBe(true);
  });

  it("拒绝非法名 (空 / 空格 / 斜杠 / 点 / 中文)", async () => {
    const { PROFILE_NAME_RE } = await loadHermes();
    expect(PROFILE_NAME_RE.test("")).toBe(false);
    expect(PROFILE_NAME_RE.test("has space")).toBe(false);
    expect(PROFILE_NAME_RE.test("a/b")).toBe(false);
    expect(PROFILE_NAME_RE.test("..")).toBe(false);
    expect(PROFILE_NAME_RE.test("中文")).toBe(false);
  });
});

describe("listHermesProfiles", () => {
  it("profiles/ 不存在 → []", async () => {
    const { listHermesProfiles } = await loadHermes();
    expect(listHermesProfiles()).toEqual([]);
  });

  it("空 profiles/ → []", async () => {
    mkdirSync(join(tmpHome, ".hermes", "profiles"), { recursive: true });
    const { listHermesProfiles } = await loadHermes();
    expect(listHermesProfiles()).toEqual([]);
  });

  it("列出多个合法目录, 排序无所谓 (用 sort 再比)", async () => {
    mkdirSync(join(tmpHome, ".hermes", "profiles", "coder"), { recursive: true });
    mkdirSync(join(tmpHome, ".hermes", "profiles", "work"), { recursive: true });
    mkdirSync(join(tmpHome, ".hermes", "profiles", "my-bot_2"), { recursive: true });
    const { listHermesProfiles } = await loadHermes();
    expect(listHermesProfiles().sort()).toEqual(["coder", "my-bot_2", "work"]);
  });

  it("过滤掉文件 / 隐藏目录 / 非法名目录", async () => {
    const profilesDir = join(tmpHome, ".hermes", "profiles");
    mkdirSync(profilesDir, { recursive: true });
    mkdirSync(join(profilesDir, "coder"), { recursive: true });
    mkdirSync(join(profilesDir, ".hidden"), { recursive: true });
    mkdirSync(join(profilesDir, "has space"), { recursive: true });
    writeFileSync(join(profilesDir, "notes.txt"), "x");
    const { listHermesProfiles } = await loadHermes();
    expect(listHermesProfiles()).toEqual(["coder"]);
  });

  it("symlink 指向目录 → 跟进解引用接受", async () => {
    const profilesDir = join(tmpHome, ".hermes", "profiles");
    mkdirSync(profilesDir, { recursive: true });
    const realDir = join(tmpHome, "_real_profile_target");
    mkdirSync(realDir, { recursive: true });
    symlinkSync(realDir, join(profilesDir, "linked"));
    const { listHermesProfiles } = await loadHermes();
    expect(listHermesProfiles()).toContain("linked");
  });
});

describe("detectActiveProfile — (1) env var", () => {
  it("HERMES_HOME = ~/.hermes/profiles/coder → 返 coder", async () => {
    process.env.HERMES_HOME = join(tmpHome, ".hermes", "profiles", "coder");
    const { detectActiveProfile } = await loadHermes();
    expect(detectActiveProfile()).toBe("coder");
  });

  it("HERMES_HOME = ~/.hermes/profiles/my-bot_2 → 返 my-bot_2", async () => {
    process.env.HERMES_HOME = join(tmpHome, ".hermes", "profiles", "my-bot_2");
    const { detectActiveProfile } = await loadHermes();
    expect(detectActiveProfile()).toBe("my-bot_2");
  });

  it("HERMES_HOME = ~/.hermes (默认 home, 非 profile) → 落到下一段", async () => {
    process.env.HERMES_HOME = join(tmpHome, ".hermes");
    // 没 mock execSync, hermes 二进制不在 PATH → 返 null
    const { detectActiveProfile } = await loadHermes();
    expect(detectActiveProfile()).toBeNull();
  });

  it("HERMES_HOME = 不相关路径 → 落到下一段 → null", async () => {
    process.env.HERMES_HOME = "/some/unrelated/path";
    const { detectActiveProfile } = await loadHermes();
    expect(detectActiveProfile()).toBeNull();
  });

  it("HERMES_HOME 中 profile 名非法 → 落到下一段 → null", async () => {
    process.env.HERMES_HOME = join(tmpHome, ".hermes", "profiles", "has space");
    const { detectActiveProfile } = await loadHermes();
    expect(detectActiveProfile()).toBeNull();
  });
});

describe("detectActiveProfile — (2) exec hermes profile list", () => {
  it("mock execSync 返 '* coder' 格式 → 返 coder", async () => {
    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => tmpHome };
    });
    vi.doMock("node:child_process", async () => {
      const actual =
        await vi.importActual<typeof import("node:child_process")>(
          "node:child_process"
        );
      return {
        ...actual,
        execSync: vi.fn(() => "* coder\n  work\n  research\n"),
      };
    });
    const { detectActiveProfile } = await loadHermes();
    expect(detectActiveProfile()).toBe("coder");
  });

  it("mock execSync 返 'coder (active)' 格式 → 返 coder", async () => {
    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => tmpHome };
    });
    vi.doMock("node:child_process", async () => {
      const actual =
        await vi.importActual<typeof import("node:child_process")>(
          "node:child_process"
        );
      return {
        ...actual,
        execSync: vi.fn(() => "  work\n  coder (active)\n  research\n"),
      };
    });
    const { detectActiveProfile } = await loadHermes();
    expect(detectActiveProfile()).toBe("coder");
  });

  it("mock execSync 抛错 (hermes 不在 PATH) → null", async () => {
    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => tmpHome };
    });
    vi.doMock("node:child_process", async () => {
      const actual =
        await vi.importActual<typeof import("node:child_process")>(
          "node:child_process"
        );
      return {
        ...actual,
        execSync: vi.fn(() => {
          throw new Error("hermes: command not found");
        }),
      };
    });
    const { detectActiveProfile } = await loadHermes();
    expect(detectActiveProfile()).toBeNull();
  });

  it("mock execSync 返不可解析的输出 → null", async () => {
    vi.resetModules();
    vi.doMock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => tmpHome };
    });
    vi.doMock("node:child_process", async () => {
      const actual =
        await vi.importActual<typeof import("node:child_process")>(
          "node:child_process"
        );
      return {
        ...actual,
        execSync: vi.fn(() => "some bogus content with no profile marker\n"),
      };
    });
    const { detectActiveProfile } = await loadHermes();
    expect(detectActiveProfile()).toBeNull();
  });
});
