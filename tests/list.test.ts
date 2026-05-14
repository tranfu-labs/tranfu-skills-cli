import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TfsError } from "../src/types.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(
    tmpdir(),
    `list-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

function seedSkill(
  runtime: "claude" | "codex",
  name: string,
  frontmatter: string
) {
  const dir = join(tmpHome, `.${runtime}`, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n# body\n`);
}

const intactFm = (sha: string) => `name: foo
description: foo desc
installed_by: tranfu-skills
installed_version: ${sha}
installed_at: 2026-05-14
installed_source: own`;

const partialFm = `name: bar
description: bar desc
installed_by: tranfu-skills
installed_at: 2026-05-14
installed_source: own`;

const handmadeFm = `name: my-handmade
description: I wrote this myself`;

async function loadList() {
  return await import("../src/commands/list.js");
}

function captureExit() {
  return vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
}

describe("list — 空目录情况", () => {
  it("user dir 不存在 → empty list 人话", async () => {
    // 移除 .claude/skills (但 .claude 保留, 让 runtime 探测 OK)
    rmSync(join(tmpHome, ".claude", "skills"), { recursive: true });
    const { listCommand } = await loadList();
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await listCommand({ scope: "user", runtime: "claude-code" });
    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("No tranfu-skills installed");
  });

  it("user dir 存在但只有非 tranfu-skills 内容 → empty list", async () => {
    seedSkill("claude", "my-handmade", handmadeFm);
    const { listCommand } = await loadList();
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await listCommand({ scope: "user", runtime: "claude-code" });
    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("No tranfu-skills installed");
  });

  it("--json 空列表 → {installed: []}", async () => {
    const { listCommand } = await loadList();
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await listCommand({ scope: "user", runtime: "claude-code", json: true });
    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(out);
    expect(parsed.installed).toEqual([]);
  });
});

describe("list — 多 skill 混合", () => {
  it("列出 intact + partial, skip handmade", async () => {
    seedSkill("claude", "foo", intactFm("abc123def456"));
    seedSkill("claude", "bar", partialFm);
    seedSkill("claude", "my-handmade", handmadeFm);
    const { listCommand } = await loadList();
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await listCommand({ scope: "user", runtime: "claude-code" });
    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("2 skill(s) installed");
    expect(out).toContain("foo");
    expect(out).toContain("bar");
    expect(out).toContain("[partial]");  // bar 是 partial
    expect(out).not.toContain("my-handmade");
    expect(out).toContain("abc123d");  // short sha of foo
  });

  it("--json 完整 schema", async () => {
    seedSkill("claude", "foo", intactFm("abc123def456"));
    seedSkill("claude", "bar", partialFm);
    const { listCommand } = await loadList();
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await listCommand({ scope: "user", runtime: "claude-code", json: true });
    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(out);
    expect(parsed.installed).toHaveLength(2);
    const foo = parsed.installed.find((s: any) => s.name === "foo");
    expect(foo).toMatchObject({
      name: "foo",
      version: "abc123def456",
      scope: "user",
      runtime: "claude-code",
    });
    expect(foo.path).toContain("foo");
    expect(foo.status).toBeUndefined();  // intact 不打 status 字段
    const bar = parsed.installed.find((s: any) => s.name === "bar");
    expect(bar.status).toBe("partial");
  });

  it("跳过 .tfs-staging 子目录 (dotfile 全 skip)", async () => {
    seedSkill("claude", "real-one", intactFm("xyz"));
    // 模拟 staging 残留
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
      `---\n${intactFm("staging-sha")}\n---`
    );
    const { listCommand } = await loadList();
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await listCommand({ scope: "user", runtime: "claude-code" });
    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("1 skill(s)");
    expect(out).toContain("real-one");
    expect(out).not.toContain("interrupted");
    expect(out).not.toContain(".tfs-staging");
  });
});

describe("list — runtime/scope 错误", () => {
  it("--runtime invalid → exit 1 runtime_invalid", async () => {
    const { listCommand } = await loadList();
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    captureExit();
    await expect(
      listCommand({ scope: "user", runtime: "vim" })
    ).rejects.toThrow("process.exit called");
    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("runtime_invalid");
  });

  it("--scope invalid → exit 1 scope_invalid", async () => {
    const { listCommand } = await loadList();
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    captureExit();
    await expect(
      listCommand({ scope: "global", runtime: "claude-code" })
    ).rejects.toThrow("process.exit called");
    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("scope_invalid");
  });
});

describe("list — codex runtime", () => {
  it("list ~/.codex/skills/ (--runtime=codex)", async () => {
    seedSkill("codex", "codex-skill", intactFm("def456"));
    const { listCommand } = await loadList();
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await listCommand({ scope: "user", runtime: "codex", json: true });
    const parsed = JSON.parse(
      stdoutSpy.mock.calls.map((c) => c[0]).join("")
    );
    expect(parsed.installed).toHaveLength(1);
    expect(parsed.installed[0].runtime).toBe("codex");
    expect(parsed.installed[0].path).toContain("/.codex/skills/");
  });
});
