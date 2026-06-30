import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(
    tmpdir(),
    `registry-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

function seedStampedSkill(runtime: "claude-code" | "codex", name: string, sha: string) {
  const root = runtime === "claude-code" ? ".claude" : ".codex";
  const dir = join(tmpHome, root, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: x\ninstalled_by: tranfu-skills\ninstalled_version: ${sha}\ninstalled_at: 2026-05-14\ninstalled_source: own\n---\n# ${name}\n`
  );
  return dir;
}

async function loadRegistry() {
  return await import("../src/lib/registry.js");
}

describe("registry — bootstrap from stamps", () => {
  it("registry 文件不存在时, 首次 readRegistry 扫 stamp 构建并落盘", async () => {
    const fooDir = seedStampedSkill("claude-code", "foo", "abc1234");
    const barDir = seedStampedSkill("codex", "bar", "def5678");
    const reg = await loadRegistry();

    const entries = reg.readRegistry();
    expect(entries).toHaveLength(2);
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["bar", "foo"]);
    expect(entries.find((e) => e.name === "foo")?.path).toBe(fooDir);
    expect(entries.find((e) => e.name === "bar")?.runtime).toBe("codex");
    expect(entries.find((e) => e.name === "bar")?.path).toBe(barDir);

    expect(existsSync(join(tmpHome, ".tfs", "installed.json"))).toBe(true);
  });

  it("无戳目录跳过 (用户手装)", async () => {
    const handmadeDir = join(tmpHome, ".claude", "skills", "handmade");
    mkdirSync(handmadeDir, { recursive: true });
    writeFileSync(join(handmadeDir, "SKILL.md"), `---\nname: handmade\n---\n# x\n`);
    const reg = await loadRegistry();
    expect(reg.readRegistry()).toHaveLength(0);
  });

  it("空 ~/.tfs/installed.json 损坏 → 视为缺失重建", async () => {
    seedStampedSkill("claude-code", "foo", "abc");
    mkdirSync(join(tmpHome, ".tfs"), { recursive: true });
    writeFileSync(join(tmpHome, ".tfs", "installed.json"), "{not json");
    const reg = await loadRegistry();
    const entries = reg.readRegistry();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("foo");
  });
});

describe("registry — addEntry / removeEntryByPath", () => {
  it("addEntry 追加; 同 path 已存在则覆盖 (update 场景)", async () => {
    const reg = await loadRegistry();
    reg.addEntry({
      name: "foo",
      runtime: "claude-code",
      scope: "user",
      path: "/x/foo",
      installed_version: "v1",
      installed_at: "2026-05-14",
    });
    // 这个 entry 在磁盘上 path 不存在, 下次 read 会被 prune.
    // 但 addEntry 自己不做 prune, 它直接读 registry (lazy prune 已在 readRegistry 内执行).

    // 为测覆盖, 先建实路径
    mkdirSync("/tmp/registry-add-test-foo", { recursive: true });
    reg.addEntry({
      name: "foo",
      runtime: "claude-code",
      scope: "user",
      path: "/tmp/registry-add-test-foo",
      installed_version: "v1",
      installed_at: "2026-05-14",
    });
    reg.addEntry({
      name: "foo",
      runtime: "claude-code",
      scope: "user",
      path: "/tmp/registry-add-test-foo",
      installed_version: "v2",
      installed_at: "2026-05-14",
    });
    const entries = reg.readRegistry();
    const fooEntries = entries.filter((e) => e.path === "/tmp/registry-add-test-foo");
    expect(fooEntries).toHaveLength(1);
    expect(fooEntries[0]!.installed_version).toBe("v2");

    rmSync("/tmp/registry-add-test-foo", { recursive: true, force: true });
  });

  it("removeEntryByPath 删 entry; 不存在的 path 幂等无报错", async () => {
    const dir = seedStampedSkill("claude-code", "foo", "abc");
    const reg = await loadRegistry();
    reg.readRegistry(); // bootstrap

    reg.removeEntryByPath(dir);
    expect(reg.readRegistry()).toHaveLength(0);

    // 幂等
    reg.removeEntryByPath(dir);
    reg.removeEntryByPath("/never-existed");
    expect(reg.readRegistry()).toHaveLength(0);
  });
});

describe("registry — lazy prune", () => {
  it("path 不存在的 entry 自动 prune + 回写", async () => {
    seedStampedSkill("claude-code", "foo", "abc");
    const reg = await loadRegistry();
    reg.readRegistry(); // bootstrap creates registry with foo

    // 物理删 foo 目录
    rmSync(join(tmpHome, ".claude", "skills", "foo"), { recursive: true });

    const entries = reg.readRegistry();
    expect(entries).toHaveLength(0);

    // 文件内容也回写为空 entries
    const raw = JSON.parse(
      readFileSync(join(tmpHome, ".tfs", "installed.json"), "utf8")
    );
    expect(raw.entries).toEqual([]);
  });
});

describe("registry — findByName", () => {
  it("跨 runtime 同名 skill 返回多 entry", async () => {
    seedStampedSkill("claude-code", "shared", "v1");
    seedStampedSkill("codex", "shared", "v1");
    const reg = await loadRegistry();
    const found = reg.findByName("shared");
    expect(found).toHaveLength(2);
    const runtimes = found.map((e) => e.runtime).sort();
    expect(runtimes).toEqual(["claude-code", "codex"]);
  });

  it("无匹配返空数组", async () => {
    const reg = await loadRegistry();
    expect(reg.findByName("nonexistent")).toEqual([]);
  });
});

/** seed 一个真实存在的 path, 把 entry 写到 ~/.tfs/installed.json. 用旧字符串 scope. */
function writeRawRegistry(
  entries: Array<{ name: string; runtime: string; scope: unknown; path: string }>
) {
  mkdirSync(join(tmpHome, ".tfs"), { recursive: true });
  const file = {
    version: 1,
    entries: entries.map((e) => ({
      ...e,
      installed_version: "v1",
      installed_at: "2026-05-14",
    })),
  };
  writeFileSync(
    join(tmpHome, ".tfs", "installed.json"),
    JSON.stringify(file, null, 2),
    "utf8"
  );
}

describe("registry — lazy migrate (旧字符串 scope → 对象)", () => {
  it("旧字符串 scope 'user' 自动迁成 {kind:'user'}", async () => {
    // 真实目录, 让 lazy prune 不删它
    const dir = seedStampedSkill("claude-code", "foo", "abc");
    writeRawRegistry([
      { name: "foo", runtime: "claude-code", scope: "user", path: dir },
    ]);
    const reg = await loadRegistry();
    const entries = reg.readRegistry();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.scope).toEqual({ kind: "user" });
    // 回写也应是对象
    const onDisk = JSON.parse(
      readFileSync(join(tmpHome, ".tfs", "installed.json"), "utf8")
    );
    expect(onDisk.entries[0].scope).toEqual({ kind: "user" });
  });

  it("旧字符串 scope 'project' 自动迁成 {kind:'project'}", async () => {
    const dir = seedStampedSkill("claude-code", "foo", "abc");
    writeRawRegistry([
      { name: "foo", runtime: "claude-code", scope: "project", path: dir },
    ]);
    const reg = await loadRegistry();
    const entries = reg.readRegistry();
    expect(entries[0]!.scope).toEqual({ kind: "project" });
  });

  it("不可识别 scope 值 → 丢弃该 entry (不影响其他 entry)", async () => {
    const goodDir = seedStampedSkill("claude-code", "foo", "abc");
    const badDir = seedStampedSkill("codex", "bar", "def");
    writeRawRegistry([
      { name: "foo", runtime: "claude-code", scope: "user", path: goodDir },
      { name: "bar", runtime: "codex", scope: "weirdvalue", path: badDir },
    ]);
    const reg = await loadRegistry();
    const entries = reg.readRegistry();
    // bar 因 scope 不可识别被丢弃
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("foo");
  });

  it("新对象 scope {kind:'profile',name:'coder'} 直接接受", async () => {
    // seed hermes profile 目录 (含 tranfu 分组)
    const hermesDir = join(
      tmpHome,
      ".hermes",
      "profiles",
      "coder",
      "skills",
      "tranfu",
      "baz"
    );
    mkdirSync(hermesDir, { recursive: true });
    writeFileSync(
      join(hermesDir, "SKILL.md"),
      `---\ninstalled_by: tranfu-skills\ninstalled_version: ghi\ninstalled_at: 2026-05-14\ninstalled_source: own\n---\n`
    );
    writeRawRegistry([
      {
        name: "baz",
        runtime: "hermes",
        scope: { kind: "profile", name: "coder" },
        path: hermesDir,
      },
    ]);
    const reg = await loadRegistry();
    const entries = reg.readRegistry();
    expect(entries[0]!.scope).toEqual({ kind: "profile", name: "coder" });
  });
});

describe("registry — bootstrap 覆盖 hermes 多 profile", () => {
  it("hermes 默认 + 命名 profile 都扫到, 各自 entry scope 正确", async () => {
    // 默认 profile (~/.hermes/skills/tranfu/foo)
    const defaultDir = join(tmpHome, ".hermes", "skills", "tranfu", "foo");
    mkdirSync(defaultDir, { recursive: true });
    writeFileSync(
      join(defaultDir, "SKILL.md"),
      `---\ninstalled_by: tranfu-skills\ninstalled_version: v1\ninstalled_at: 2026-05-14\ninstalled_source: own\n---\n`
    );
    // 命名 profile coder
    const coderDir = join(
      tmpHome,
      ".hermes",
      "profiles",
      "coder",
      "skills",
      "tranfu",
      "bar"
    );
    mkdirSync(coderDir, { recursive: true });
    writeFileSync(
      join(coderDir, "SKILL.md"),
      `---\ninstalled_by: tranfu-skills\ninstalled_version: v2\ninstalled_at: 2026-05-14\ninstalled_source: own\n---\n`
    );

    const reg = await loadRegistry();
    const entries = reg.readRegistry();
    const hermesEntries = entries.filter((e) => e.runtime === "hermes");
    expect(hermesEntries).toHaveLength(2);

    const fooEntry = hermesEntries.find((e) => e.name === "foo");
    expect(fooEntry?.scope).toEqual({ kind: "user" });

    const barEntry = hermesEntries.find((e) => e.name === "bar");
    expect(barEntry?.scope).toEqual({ kind: "profile", name: "coder" });
  });
});
