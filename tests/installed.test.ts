import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TfsError } from "../src/types.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(
    tmpdir(),
    `installed-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  // 默认两个 runtime 都存在 (各 test 内按需 rm 来制造单 runtime 场景)
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

const intactFm = (sha: string, source = "own") => `name: foo
description: foo desc
installed_by: tranfu-skills
installed_version: ${sha}
installed_at: 2026-05-14
installed_source: ${source}`;

const partialFm = `name: bar
description: bar desc
installed_by: tranfu-skills
installed_at: 2026-05-14`;

const handmadeFm = `name: my-handmade
description: handmade`;

function seed(
  runtime: "claude" | "codex",
  name: string,
  frontmatter: string
) {
  const dir = join(tmpHome, `.${runtime}`, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n`);
}

async function loadInstalled() {
  return await import("../src/commands/installed.js");
}

function captureExit() {
  return vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
}

describe("installed — 默认跨 runtime 扫", () => {
  it("user scope 无 --runtime → 跨 claude+codex 一起列", async () => {
    seed("claude", "foo", intactFm("abc"));
    seed("codex", "bar", intactFm("def", "external"));
    const { installedCommand } = await loadInstalled();
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await installedCommand({ json: true });

    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""));
    expect(parsed.installed).toHaveLength(2);
    const runtimes = parsed.installed.map((s: any) => s.runtime).sort();
    expect(runtimes).toEqual(["claude-code", "codex"]);
  });

  it("人话输出: 跨 runtime 时每行带 runtime/scope 后缀", async () => {
    seed("claude", "foo", intactFm("abc123def"));
    seed("codex", "bar", intactFm("xyz789abc"));
    const { installedCommand } = await loadInstalled();
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await installedCommand({});

    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("2 skill(s) installed");
    expect(out).toContain("foo");
    expect(out).toContain("claude-code/user");
    expect(out).toContain("bar");
    expect(out).toContain("codex/user");
  });

  it("空: 两个 runtime 都没装过 skill", async () => {
    const { installedCommand } = await loadInstalled();
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await installedCommand({ json: true });
    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""));
    expect(parsed.installed).toEqual([]);
  });
});

describe("installed — 显式 --runtime", () => {
  it("--runtime=claude-code → 只扫 claude", async () => {
    seed("claude", "foo", intactFm("abc"));
    seed("codex", "bar", intactFm("def"));
    const { installedCommand } = await loadInstalled();
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await installedCommand({ runtime: "claude-code", json: true });

    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""));
    expect(parsed.installed).toHaveLength(1);
    expect(parsed.installed[0].name).toBe("foo");
    expect(parsed.installed[0].runtime).toBe("claude-code");
  });
});

describe("installed — 戳过滤", () => {
  it("跳过 handmade (无 installed_by 戳)", async () => {
    seed("claude", "tfs-installed", intactFm("abc"));
    seed("claude", "my-handmade", handmadeFm);
    const { installedCommand } = await loadInstalled();
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await installedCommand({ json: true });

    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""));
    expect(parsed.installed.map((s: any) => s.name)).toEqual(["tfs-installed"]);
  });

  it("partial 戳显示 [partial] + status:'partial' in JSON", async () => {
    seed("claude", "bar", partialFm);
    const { installedCommand } = await loadInstalled();
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await installedCommand({ json: true });
    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""));
    expect(parsed.installed[0].status).toBe("partial");
  });

  it("跳过 .tfs-staging dotdir", async () => {
    seed("claude", "real", intactFm("real"));
    const stagingDir = join(
      tmpHome,
      ".claude",
      "skills",
      ".tfs-staging",
      "interrupted"
    );
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(
      join(stagingDir, "SKILL.md"),
      `---\n${intactFm("staging")}\n---`
    );
    const { installedCommand } = await loadInstalled();
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await installedCommand({ json: true });
    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""));
    expect(parsed.installed.map((s: any) => s.name)).toEqual(["real"]);
  });
});

describe("installed — 错误路径", () => {
  it("--scope=invalid → scope_invalid", async () => {
    const { installedCommand } = await loadInstalled();
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    captureExit();
    await expect(installedCommand({ scope: "global" })).rejects.toThrow(
      "process.exit called"
    );
    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("scope_invalid");
  });

  it("--runtime=invalid → runtime_invalid", async () => {
    const { installedCommand } = await loadInstalled();
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    captureExit();
    await expect(
      installedCommand({ runtime: "vim" })
    ).rejects.toThrow("process.exit called");
    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("runtime_invalid");
  });
});

describe("installed — slice-3 outdated 标记", () => {
  function mockFetchOk(body: unknown) {
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  }

  const indexWithFoo = {
    version: 1 as const,
    generated_at: "2026-05-14T00:00:00.000Z",
    skills: [
      {
        name: "foo",
        type: "own" as const,
        description: "foo",
        path: "own-skills/foo",
        files: ["SKILL.md"],
        sha: "new-foo-sha",
      },
    ],
  };

  it("--json: outdated:true when stamp sha != index sha", async () => {
    seed("claude", "foo", intactFm("old-foo-sha"));
    vi.stubGlobal("fetch", mockFetchOk(indexWithFoo));

    const { installedCommand } = await loadInstalled();
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await installedCommand({ json: true });

    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""));
    expect(parsed.installed[0]).toMatchObject({
      name: "foo",
      outdated: true,
    });
    expect(parsed.stale_hint).toEqual({
      outdated_count: 1,
      names: ["foo"],
    });
  });

  it("--json: outdated:false when stamp sha == index sha", async () => {
    seed("claude", "foo", intactFm("new-foo-sha"));
    vi.stubGlobal("fetch", mockFetchOk(indexWithFoo));

    const { installedCommand } = await loadInstalled();
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await installedCommand({ json: true });

    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""));
    expect(parsed.installed[0]).toMatchObject({
      name: "foo",
      outdated: false,
    });
    expect(parsed.stale_hint).toBeUndefined(); // 0 outdated → absent (DoD-002)
  });

  it("text: outdated skill 行尾追 ' outdated', latest 行不追", async () => {
    seed("claude", "foo", intactFm("old-foo-sha")); // outdated
    seed("codex", "bar", intactFm("any-sha")); // 不在 index → deleted-upstream (not outdated)
    vi.stubGlobal("fetch", mockFetchOk(indexWithFoo));

    const { installedCommand } = await loadInstalled();
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await installedCommand({});

    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    // foo 行 (outdated) 末尾追 ' outdated'
    expect(out).toMatch(/foo\s+old-foo\s+claude-code\/user outdated\n/);
    // bar 行 (deleted-upstream, not outdated) 不追
    expect(out).toMatch(/bar\s+any-sha\s+codex\/user\n/);
    expect(out).not.toMatch(/bar.*outdated/);
  });

  it("text: 0 outdated → 行末无 ' outdated' suffix (byte-equal 现行格式)", async () => {
    seed("claude", "foo", intactFm("new-foo-sha")); // latest
    vi.stubGlobal("fetch", mockFetchOk(indexWithFoo));

    const { installedCommand } = await loadInstalled();
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await installedCommand({});

    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).not.toMatch(/outdated/);
    // 主输出格式锁
    expect(out).toMatchInlineSnapshot(`
      "1 skill(s) installed:
        foo  new-foo  claude-code/user
      "
    `);
  });
});
