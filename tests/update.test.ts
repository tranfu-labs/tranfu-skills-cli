import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IndexJson, TfsError } from "../src/types.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(
    tmpdir(),
    `update-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(join(tmpHome, ".claude", "skills"), { recursive: true });
  mkdirSync(join(tmpHome, ".agents", "skills"), { recursive: true });
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return { ...actual, homedir: () => tmpHome };
  });
});

afterEach(() => {
  vi.doUnmock("node:os");
  vi.doUnmock("../src/lib/npm.js");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

function captureExit() {
  return vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
}

async function loadUpdate(npmMock: {
  getGlobalVersion?: (pkg: string) => string | null;
  getRegistryLatest?: (pkg: string) => string | null;
  installGlobalLatest?: (pkg: string) => void;
}) {
  vi.doMock("../src/lib/npm.js", () => ({
    getGlobalVersion: npmMock.getGlobalVersion ?? (() => null),
    getRegistryLatest: npmMock.getRegistryLatest ?? (() => null),
    installGlobalLatest: npmMock.installGlobalLatest ?? (() => undefined),
  }));
  return await import("../src/commands/update.js");
}

function seedSkill(
  runtime: "claude" | "codex",
  name: string,
  sha: string
) {
  const runtimeDir = runtime === "claude" ? ".claude" : ".agents";
  const dir = join(tmpHome, runtimeDir, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---
name: ${name}
description: ${name} desc
installed_by: tranfu-skills
installed_version: ${sha}
installed_at: 2026-01-01
installed_source: own
---
# old body
`
  );
  return dir;
}

const baseIndex: IndexJson = {
  version: 1,
  generated_at: "2026-05-14T00:00:00.000Z",
  skills: [
    {
      name: "skill-a",
      type: "own",
      description: "skill A",
      path: "own-skills/skill-a",
      files: ["SKILL.md"],
      sha: "new-sha-a",
    },
    {
      name: "skill-b",
      type: "external",
      description: "skill B",
      path: "external-skills/skill-b",
      files: ["SKILL.md"],
      sha: "current-sha-b",
      source_url: "https://github.com/example/b",
    },
  ],
};

function mockFetchSequence(
  indexBody: unknown,
  fileBodies: string[]
) {
  let i = 0;
  return vi.fn().mockImplementation(() => {
    if (i === 0) {
      i++;
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: () => Promise.resolve(JSON.stringify(indexBody)),
      });
    }
    const body = fileBodies[i - 1];
    i++;
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(body ?? ""),
    });
  });
}

describe("update --skills-only (Phase 5.2)", () => {
  it("跨 runtime 扫 → sha 一致全 noop, 不下载文件", async () => {
    seedSkill("claude", "skill-a", "new-sha-a");
    seedSkill("codex", "skill-b", "current-sha-b");
    const fetchSpy = mockFetchSequence(baseIndex, []);
    vi.stubGlobal("fetch", fetchSpy);

    const { updateCommand } = await loadUpdate({});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await updateCommand({ skillsOnly: true, json: true });

    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""));
    expect(parsed.self).toBeNull();
    expect(parsed.skills).toHaveLength(2);
    expect(parsed.skills.every((s: any) => s.status === "noop")).toBe(true);
    // 只 fetch 一次 (index), 不拉文件
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("sha 不一致 → 重装 + 输出 updated", async () => {
    seedSkill("claude", "skill-a", "OLD-SHA");
    const fetchSpy = mockFetchSequence(baseIndex, [
      "---\nname: skill-a\ndescription: new\n---\n# new body",
    ]);
    vi.stubGlobal("fetch", fetchSpy);

    const { updateCommand } = await loadUpdate({});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await updateCommand({ skillsOnly: true });

    // 文件被替换 + 新 stamp
    const md = readFileSync(
      join(tmpHome, ".claude", "skills", "skill-a", "SKILL.md"),
      "utf8"
    );
    expect(md).toContain("installed_version: new-sha-a");
    expect(md).toContain("# new body");
    expect(md).not.toContain("OLD-SHA");
  });

  it("skill 不在 index → status=deleted-upstream, 文件保留", async () => {
    seedSkill("claude", "skill-a", "new-sha-a");
    seedSkill("claude", "orphan-skill", "any-sha");
    vi.stubGlobal("fetch", mockFetchSequence(baseIndex, []));

    const { updateCommand } = await loadUpdate({});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await updateCommand({ skillsOnly: true, json: true });

    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""));
    const orphan = parsed.skills.find((s: any) => s.name === "orphan-skill");
    expect(orphan.status).toBe("deleted-upstream");

    // 文件保留
    expect(
      existsSync(join(tmpHome, ".claude", "skills", "orphan-skill"))
    ).toBe(true);
  });

  it("handmade (无戳) 不参与 update", async () => {
    seedSkill("claude", "skill-a", "new-sha-a");
    const handmadeDir = join(tmpHome, ".claude", "skills", "my-handmade");
    mkdirSync(handmadeDir, { recursive: true });
    writeFileSync(
      join(handmadeDir, "SKILL.md"),
      `---\nname: my-handmade\ndescription: hand\n---`
    );
    vi.stubGlobal("fetch", mockFetchSequence(baseIndex, []));

    const { updateCommand } = await loadUpdate({});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await updateCommand({ skillsOnly: true, json: true });

    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""));
    expect(parsed.skills.map((s: any) => s.name)).toEqual(["skill-a"]);
    // handmade 仍在
    expect(existsSync(handmadeDir)).toBe(true);
  });

  it("--skills-only 不调 npm self update", async () => {
    const installSpy = vi.fn();
    vi.stubGlobal("fetch", mockFetchSequence(baseIndex, []));
    const { updateCommand } = await loadUpdate({
      installGlobalLatest: installSpy,
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await updateCommand({ skillsOnly: true });

    expect(installSpy).not.toHaveBeenCalled();
  });
});

describe("update default (self + skills)", () => {
  it("默认 = self + skills 都跑", async () => {
    seedSkill("claude", "skill-a", "new-sha-a");
    vi.stubGlobal("fetch", mockFetchSequence(baseIndex, []));
    const installSpy = vi.fn();
    const { updateCommand } = await loadUpdate({
      getGlobalVersion: () => "0.1.0",
      getRegistryLatest: () => "0.1.0", // self noop
      installGlobalLatest: installSpy,
    });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await updateCommand({ json: true });

    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""));
    expect(parsed.self).toMatchObject({ from: "0.1.0", to: "0.1.0", status: "noop" });
    expect(parsed.skills).toHaveLength(1);
  });
});

describe("update --self (Phase 5.1 仍工作)", () => {
  it("--self → 只跑 self, 不扫 skills (即使本地有装)", async () => {
    seedSkill("claude", "skill-a", "OLD"); // 故意装个 stale, 验证 --self 不会动它
    const installSpy = vi.fn();
    const { updateCommand } = await loadUpdate({
      getGlobalVersion: () => "0.1.0",
      getRegistryLatest: () => "0.1.0",
      installGlobalLatest: installSpy,
    });
    // 关键: 不 stub fetch — 如果 update 真的去扫 skills 它会因为 fetch undefined 而崩
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await updateCommand({ self: true });

    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("already latest");
    // skill-a 文件未被改 (仍是 OLD stamp)
    const md = readFileSync(
      join(tmpHome, ".claude", "skills", "skill-a", "SKILL.md"),
      "utf8"
    );
    expect(md).toContain("installed_version: OLD");
  });
});

describe("update --ack-deletions (Phase 5.4)", () => {
  it("无 --ack-deletions: deleted-upstream skill 输出 warn", async () => {
    seedSkill("claude", "orphan", "any");
    vi.stubGlobal("fetch", mockFetchSequence(baseIndex, []));
    const { updateCommand } = await loadUpdate({});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await updateCommand({ skillsOnly: true });
    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("deleted-upstream");
    expect(out).toContain("orphan");
    expect(out).toContain("--ack-deletions");
  });

  it("--ack-deletions: 写入 ack.json + status 升级 + 人话 ✓ acked", async () => {
    seedSkill("claude", "orphan", "any");
    vi.stubGlobal("fetch", mockFetchSequence(baseIndex, []));
    const { updateCommand } = await loadUpdate({});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await updateCommand({ skillsOnly: true, ackDeletions: true });

    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("✓ acked 1");
    // ack.json 写了
    const ackPath = join(tmpHome, ".tfs", "cache", "ack.json");
    expect(existsSync(ackPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(ackPath, "utf8"));
    expect(parsed.deleted_upstream).toEqual(["orphan"]);
  });

  it("已 ack 的 skill: 默认 update 不输出人话 warn", async () => {
    seedSkill("claude", "orphan", "any");
    // 预 seed ack.json
    mkdirSync(join(tmpHome, ".tfs", "cache"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".tfs", "cache", "ack.json"),
      JSON.stringify({ deleted_upstream: ["orphan"] })
    );
    vi.stubGlobal("fetch", mockFetchSequence(baseIndex, []));
    const { updateCommand } = await loadUpdate({});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await updateCommand({ skillsOnly: true });

    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).not.toContain("orphan"); // 已 ack, 人话静默
    expect(out).not.toContain("deleted-upstream"); // warn 段不显示
  });

  it("已 ack 的 skill: --json 仍输出 status=deleted-upstream-acked", async () => {
    seedSkill("claude", "orphan", "any");
    mkdirSync(join(tmpHome, ".tfs", "cache"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".tfs", "cache", "ack.json"),
      JSON.stringify({ deleted_upstream: ["orphan"] })
    );
    vi.stubGlobal("fetch", mockFetchSequence(baseIndex, []));
    const { updateCommand } = await loadUpdate({});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await updateCommand({ skillsOnly: true, json: true });

    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""));
    const orphan = parsed.skills.find((s: any) => s.name === "orphan");
    expect(orphan.status).toBe("deleted-upstream-acked");
  });

  it("--ack-deletions 合并已有 ack (不覆盖)", async () => {
    seedSkill("claude", "new-orphan", "any");
    // 已有 ack 包含一个不在 install 列表的 name (e.g. uninstall 过的旧记录)
    mkdirSync(join(tmpHome, ".tfs", "cache"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".tfs", "cache", "ack.json"),
      JSON.stringify({ deleted_upstream: ["old-ack-name"] })
    );
    vi.stubGlobal("fetch", mockFetchSequence(baseIndex, []));
    const { updateCommand } = await loadUpdate({});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await updateCommand({ skillsOnly: true, ackDeletions: true });

    const parsed = JSON.parse(
      readFileSync(join(tmpHome, ".tfs", "cache", "ack.json"), "utf8")
    );
    expect(parsed.deleted_upstream).toContain("new-orphan");
    expect(parsed.deleted_upstream).toContain("old-ack-name"); // 旧的保留
  });
});

describe("update — B1 bug fix (registry+global 都 null)", () => {
  it("两边都 null → network_error exit 2, 不盲目跑 npm install", async () => {
    const installSpy = vi.fn();
    const { updateCommand } = await loadUpdate({
      getGlobalVersion: () => null,
      getRegistryLatest: () => null,
      installGlobalLatest: installSpy,
    });
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const exitSpy = captureExit();

    await expect(updateCommand({ self: true })).rejects.toThrow(
      "process.exit called"
    );

    expect(installSpy).not.toHaveBeenCalled();
    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("network_error");
    expect(parsed.exit_code).toBe(2);
    expect(parsed.hint).toContain("npm --version");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});

describe("update — 错误路径", () => {
  it("installGlobalLatest 抛错 (default 路径) → internal_error exit 3", async () => {
    vi.stubGlobal("fetch", mockFetchSequence(baseIndex, []));
    const { updateCommand } = await loadUpdate({
      getGlobalVersion: () => "0.1.0",
      getRegistryLatest: () => "0.2.0",
      installGlobalLatest: () => {
        throw new Error("EACCES");
      },
    });
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const exitSpy = captureExit();

    await expect(updateCommand({ self: true })).rejects.toThrow(
      "process.exit called"
    );
    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("internal_error");
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it("fetchIndex 404 (--skills-only 路径) → exit 1 index_not_initialized", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: { get: () => null },
        text: () => Promise.resolve(""),
      })
    );
    const { updateCommand } = await loadUpdate({});
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    captureExit();

    await expect(updateCommand({ skillsOnly: true })).rejects.toThrow(
      "process.exit called"
    );
    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("index_not_initialized");
  });
});

describe("update --check-only (Phase 1 slice-1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns skills with status='outdated' when stamp sha != index sha", async () => {
    seedSkill("claude", "skill-a", "old-sha-a");
    vi.stubGlobal("fetch", mockFetchSequence(baseIndex, []));
    const { updateCommand } = await loadUpdate({});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await updateCommand({ checkOnly: true, json: true });

    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""));
    expect(parsed.self).toBeNull();
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.skills[0]).toMatchObject({
      name: "skill-a",
      status: "outdated",
      from: "old-sha-a",
      to: "new-sha-a",
      runtime: "claude-code",
    });
    expect(parsed.cached).toBe(false);
    expect(parsed.checked_at).toBe("2026-05-14T00:00:00Z");
  });

  it("returns empty skills[] when all stamps match (noop excluded from output)", async () => {
    seedSkill("claude", "skill-a", "new-sha-a");
    seedSkill("codex", "skill-b", "current-sha-b");
    vi.stubGlobal("fetch", mockFetchSequence(baseIndex, []));
    const { updateCommand } = await loadUpdate({});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await updateCommand({ checkOnly: true, json: true });

    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""));
    expect(parsed.skills).toEqual([]);
  });

  it("includes deleted-upstream with status='deleted-upstream', no standalone field", async () => {
    seedSkill("claude", "orphan-skill", "any-sha");
    vi.stubGlobal("fetch", mockFetchSequence(baseIndex, []));
    const { updateCommand } = await loadUpdate({});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await updateCommand({ checkOnly: true, json: true });

    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""));
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.skills[0]).toMatchObject({
      name: "orphan-skill",
      status: "deleted-upstream",
    });
    expect((parsed as { deleted_upstream?: unknown }).deleted_upstream).toBeUndefined();
  });

  it("anti-DoD: file on disk untouched after --check-only run", async () => {
    const skillDir = seedSkill("claude", "skill-a", "old-sha-a"); // outdated
    const skillMdPath = join(skillDir, "SKILL.md");
    const before = readFileSync(skillMdPath, "utf8");
    const fetchSpy = mockFetchSequence(baseIndex, []);
    vi.stubGlobal("fetch", fetchSpy);
    const { updateCommand } = await loadUpdate({});
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await updateCommand({ checkOnly: true, json: true });

    // 黑盒断言: 文件还在 + stamp 字节级未变 (rmSync / downloadSkillToTarget 都没跑)
    expect(existsSync(skillMdPath)).toBe(true);
    expect(readFileSync(skillMdPath, "utf8")).toBe(before);
    // 网络只打了 1 次 (fetchIndex), 没拉 skill 文件
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("--check-only --json output schema locked (0 outdated)", async () => {
    seedSkill("claude", "skill-a", "new-sha-a");
    vi.stubGlobal("fetch", mockFetchSequence(baseIndex, []));
    const { updateCommand } = await loadUpdate({});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await updateCommand({ checkOnly: true, json: true });

    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toMatchInlineSnapshot(`
      "{"self":null,"skills":[],"checked_at":"2026-05-14T00:00:00Z","cached":false}
      "
    `);
  });

  it("--check-only text mode 0 outdated → stdout empty", async () => {
    seedSkill("claude", "skill-a", "new-sha-a");
    vi.stubGlobal("fetch", mockFetchSequence(baseIndex, []));
    const { updateCommand } = await loadUpdate({});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await updateCommand({ checkOnly: true });

    expect(stdoutSpy.mock.calls.map((c) => c[0]).join("")).toBe("");
  });

  it("--check-only text mode N outdated → locked format, no ⚠ prefix", async () => {
    seedSkill("claude", "skill-a", "old-sha-a");
    vi.stubGlobal("fetch", mockFetchSequence(baseIndex, []));
    const { updateCommand } = await loadUpdate({});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await updateCommand({ checkOnly: true });

    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toMatchInlineSnapshot(`
      "发现 1 个 skill 可更新:
        - skill-a: old-sha..new-sha (claude-code/user)
      "
    `);
    // slice-2 piggyback marker prefix 隔离 — slice-1 text 输出禁出现 ⚠
    expect(out.startsWith("⚠")).toBe(false);
    expect(out.split("\n").some((line) => line.startsWith("⚠"))).toBe(false);
  });

  it("--check-only --self → invalid_args exit 1", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const { updateCommand } = await loadUpdate({});
    captureExit();

    await expect(
      updateCommand({ checkOnly: true, self: true })
    ).rejects.toThrow("process.exit called");

    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("invalid_args");
    expect(parsed.exit_code).toBe(1);
  });

  it("--check-only --ack-deletions → invalid_args exit 1", async () => {
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const { updateCommand } = await loadUpdate({});
    captureExit();

    await expect(
      updateCommand({ checkOnly: true, ackDeletions: true })
    ).rejects.toThrow("process.exit called");

    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("invalid_args");
  });

  it("--check-only --skills-only → behaves same as --check-only alone (noop combo)", async () => {
    seedSkill("claude", "skill-a", "old-sha-a");
    vi.stubGlobal("fetch", mockFetchSequence(baseIndex, []));
    const { updateCommand } = await loadUpdate({});
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await updateCommand({ checkOnly: true, skillsOnly: true, json: true });

    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""));
    expect(parsed.self).toBeNull();
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.skills[0].status).toBe("outdated");
  });

  it("network failure → emitError exit 2 with error='index_fetch_failed'", async () => {
    seedSkill("claude", "skill-a", "old-sha-a");
    vi.stubGlobal("fetch", () => Promise.reject(new Error("network unreachable")));
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const { updateCommand } = await loadUpdate({});
    captureExit();

    await expect(
      updateCommand({ checkOnly: true, json: true })
    ).rejects.toThrow("process.exit called");

    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("index_fetch_failed");
    expect(parsed.exit_code).toBe(2);
  });
});
