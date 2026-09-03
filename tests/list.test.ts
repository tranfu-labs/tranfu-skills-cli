import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(
    tmpdir(),
    `list-r2-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(join(tmpHome, ".claude", "skills"), { recursive: true });
  mkdirSync(join(tmpHome, ".agents", "skills"), { recursive: true });
  const cacheDir = join(tmpHome, ".tfs", "cache");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, "last-check.json"),
    JSON.stringify({
      checked_at: new Date().toISOString(),
      ttl_hours: 6,
      skills: [],
    })
  );
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return { ...actual, homedir: () => tmpHome };
  });
});

afterEach(() => {
  vi.doUnmock("node:os");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

function seedClaudeStamped(name: string, sha: string) {
  const dir = join(tmpHome, ".claude", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: x\ninstalled_by: tranfu-skills\ninstalled_version: ${sha}\ninstalled_at: 2026-05-14\ninstalled_source: own\n---\n# body\n`
  );
  return dir;
}

describe("list (r2 命名重构) — 默认 = 本地 installed alias", () => {
  it("无 flag → 列本地已装 skill (= tfs installed)", async () => {
    seedClaudeStamped("foo", "abc1234");
    const { listCommand } = await import("../src/commands/list.js");
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await listCommand({});

    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("1 skill(s) installed");
    expect(out).toContain("foo");
    expect(out).not.toContain("Remote index");
  });

  it("--json → 与 installed --json schema 等价", async () => {
    seedClaudeStamped("foo", "abc1234");
    const { listCommand } = await import("../src/commands/list.js");
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await listCommand({ json: true });

    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""));
    expect(parsed.installed).toBeDefined();
    expect(parsed.installed).toHaveLength(1);
    expect(parsed.installed[0].name).toBe("foo");
    expect(parsed.installed[0].runtime).toBe("claude-code");
    expect(parsed.installed[0].scope).toBe("user");
  });
});

describe("list --remote (deprecated) — 转发到 catalog", () => {
  it("--remote 触发 stderr deprecation warning + 跑 catalog 行为", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve(JSON.stringify({
          version: 1,
          generated_at: "2026-05-14T00:00:00Z",
          skills: [{ name: "x", type: "own", description: "d", path: "p", files: ["SKILL.md"], sha: "abc" }],
        })),
      })
    );
    const { listCommand } = await import("../src/commands/list.js");
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await listCommand({ remote: true });

    const stderr = stderrSpy.mock.calls.map((c) => c[0]).join("");
    expect(stderr).toContain("deprecated");
    expect(stderr).toContain("tfs catalog");

    const stdout = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(stdout).toContain("1 skill(s) in tranfu-skills");
  });
});
