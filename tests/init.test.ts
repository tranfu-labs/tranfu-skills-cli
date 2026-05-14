import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IndexJson, TfsError } from "../src/types.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(
    tmpdir(),
    `init-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return { ...actual, homedir: () => tmpHome };
  });
});

afterEach(() => {
  vi.doUnmock("node:os");
  vi.doUnmock("../src/lib/doctor.js");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

const indexWithMetas: IndexJson = {
  version: 1,
  generated_at: "2026-05-14T00:00:00.000Z",
  skills: [
    {
      name: "tranfu-router",
      type: "meta",
      description: "router",
      path: "meta-skills/tranfu-router",
      files: ["SKILL.md"],
      sha: "router-sha",
    },
    {
      name: "tranfu-publish",
      type: "meta",
      description: "publish",
      path: "meta-skills/tranfu-publish",
      files: ["SKILL.md"],
      sha: "publish-sha",
    },
  ],
};

function mockFetchSequence(indexBody: unknown, fileBodies: string[]) {
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
    const body = fileBodies[i - 1] ?? "";
    i++;
    return Promise.resolve({
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: () => Promise.resolve(body),
    });
  });
}

async function loadInitWithDoctor(doctorOk: boolean = true) {
  vi.doMock("../src/lib/doctor.js", () => ({
    runDoctor: () => ({
      checks: doctorOk
        ? [{ name: "node-version", status: "ok", message: "ok", fatal: true }]
        : [
            {
              name: "node-version",
              status: "fail",
              message: "Node 18 太老",
              fatal: true,
            },
          ],
      ok: doctorOk,
    }),
  }));
  return await import("../src/commands/init.js");
}

function captureExit() {
  return vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
}

describe("init — happy path (Phase 7.3 单 runtime)", () => {
  it("只装了 claude → init 装 2 个 meta-skill 到 ~/.claude/skills/", async () => {
    mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    vi.stubGlobal(
      "fetch",
      mockFetchSequence(indexWithMetas, [
        "---\nname: tranfu-router\ndescription: r\ntype: meta\n---\n# router",
        "---\nname: tranfu-publish\ndescription: p\ntype: meta\n---\n# publish",
      ])
    );
    const { initCommand } = await loadInitWithDoctor(true);
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await initCommand({});

    const skillsDir = join(tmpHome, ".claude", "skills");
    expect(existsSync(join(skillsDir, "tranfu-router", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillsDir, "tranfu-publish", "SKILL.md"))).toBe(true);

    // 两个都有 stamp
    const routerMd = readFileSync(
      join(skillsDir, "tranfu-router", "SKILL.md"),
      "utf8"
    );
    expect(routerMd).toContain("installed_by: tranfu-skills");
    expect(routerMd).toContain("installed_source: meta");
    expect(routerMd).toContain("installed_version: router-sha");

    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("✓ installed tranfu-router");
    expect(out).toContain("✓ installed tranfu-publish");
    expect(out).toContain("Restart Claude Code");
  });

  it("--runtime=codex → 装到 ~/.codex/skills/", async () => {
    mkdirSync(join(tmpHome, ".codex"), { recursive: true });
    vi.stubGlobal(
      "fetch",
      mockFetchSequence(indexWithMetas, [
        "---\nname: tranfu-router\n---",
        "---\nname: tranfu-publish\n---",
      ])
    );
    const { initCommand } = await loadInitWithDoctor(true);
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await initCommand({ runtime: "codex" });

    expect(
      existsSync(join(tmpHome, ".codex", "skills", "tranfu-router"))
    ).toBe(true);
    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("Restart Codex CLI");
  });
});

describe("init — Phase 7.5 幂等覆盖", () => {
  it("已装 → rm + 重装, 输出 refreshed", async () => {
    mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    // pre-seed: tranfu-router 已装 (老版本)
    const skillsDir = join(tmpHome, ".claude", "skills");
    mkdirSync(join(skillsDir, "tranfu-router"), { recursive: true });
    writeFileSync(
      join(skillsDir, "tranfu-router", "SKILL.md"),
      `---
name: tranfu-router
installed_by: tranfu-skills
installed_version: OLD-router-sha
installed_at: 2026-01-01
installed_source: meta
---
# old router body
`
    );
    // 还附带一个老 stale 文件
    writeFileSync(
      join(skillsDir, "tranfu-router", "stale.txt"),
      "should be gone"
    );

    vi.stubGlobal(
      "fetch",
      mockFetchSequence(indexWithMetas, [
        "---\nname: tranfu-router\n---\n# NEW router",
        "---\nname: tranfu-publish\n---",
      ])
    );
    const { initCommand } = await loadInitWithDoctor(true);
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await initCommand({ runtime: "claude-code" });

    // stale 文件没了
    expect(
      existsSync(join(skillsDir, "tranfu-router", "stale.txt"))
    ).toBe(false);
    // 新 stamp 写上
    const md = readFileSync(
      join(skillsDir, "tranfu-router", "SKILL.md"),
      "utf8"
    );
    expect(md).toContain("installed_version: router-sha"); // 新
    expect(md).not.toContain("OLD-router-sha");
    expect(md).toContain("# NEW router");

    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("✓ refreshed tranfu-router");
    expect(out).toContain("✓ installed tranfu-publish"); // 没装过 → installed
  });
});

describe("init — Phase 7.4 双 runtime", () => {
  it("--both → 装到两个 runtime", async () => {
    mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    mkdirSync(join(tmpHome, ".codex"), { recursive: true });
    vi.stubGlobal(
      "fetch",
      mockFetchSequence(indexWithMetas, [
        // claude-code: router + publish
        "---\nname: tranfu-router\n---",
        "---\nname: tranfu-publish\n---",
        // codex: router + publish (复用文件内容)
        "---\nname: tranfu-router\n---",
        "---\nname: tranfu-publish\n---",
      ])
    );
    const { initCommand } = await loadInitWithDoctor(true);
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await initCommand({ both: true });

    expect(
      existsSync(join(tmpHome, ".claude", "skills", "tranfu-router"))
    ).toBe(true);
    expect(
      existsSync(join(tmpHome, ".codex", "skills", "tranfu-router"))
    ).toBe(true);

    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    // 跨 runtime → 每行带 (runtime) 标
    expect(out).toContain("(claude-code)");
    expect(out).toContain("(codex)");
    expect(out).toContain("Restart Claude Code + Codex CLI");
  });

  it("_promptRuntimeChoice — 非 TTY → null", async () => {
    const { _promptRuntimeChoice } = await import(
      "../src/commands/init.js"
    );
    const choice = await _promptRuntimeChoice(
      ["claude-code", "codex"],
      () => {},
      false  // 非 TTY
    );
    expect(choice).toBeNull();
  });

  it("_promptRuntimeChoice — 用户选 1 → claude-code", async () => {
    const { _promptRuntimeChoice } = await import(
      "../src/commands/init.js"
    );
    const choice = await _promptRuntimeChoice(
      ["claude-code", "codex"],
      () => {},
      true, // TTY
      async () => "1"
    );
    expect(choice).toBe("claude-code");
  });

  it("_promptRuntimeChoice — 用户选 3 → both", async () => {
    const { _promptRuntimeChoice } = await import(
      "../src/commands/init.js"
    );
    const choice = await _promptRuntimeChoice(
      ["claude-code", "codex"],
      () => {},
      true,
      async () => "3"
    );
    expect(choice).toBe("both");
  });

  it("_promptRuntimeChoice — 用户选 4 (cancel) → null", async () => {
    const { _promptRuntimeChoice } = await import(
      "../src/commands/init.js"
    );
    const choice = await _promptRuntimeChoice(
      ["claude-code", "codex"],
      () => {},
      true,
      async () => "4"
    );
    expect(choice).toBeNull();
  });

  it("_promptRuntimeChoice — 用户输入非法 → null", async () => {
    const { _promptRuntimeChoice } = await import(
      "../src/commands/init.js"
    );
    const choice = await _promptRuntimeChoice(
      ["claude-code", "codex"],
      () => {},
      true,
      async () => "abc"
    );
    expect(choice).toBeNull();
  });
});

describe("init — 错误路径", () => {
  it("doctor fatal fail (Node 18) → init_precondition_failed exit 1", async () => {
    mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    const { initCommand } = await loadInitWithDoctor(false);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const exitSpy = captureExit();

    await expect(initCommand({})).rejects.toThrow("process.exit called");

    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("init_precondition_failed");
    expect(parsed.message).toContain("node-version");
    expect(parsed.hint).toContain("tfs doctor");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("router 不在 index → skill_not_found", async () => {
    mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    const incompleteIndex: IndexJson = {
      ...indexWithMetas,
      skills: [indexWithMetas.skills[1]!], // 只有 publish, 没 router
    };
    vi.stubGlobal(
      "fetch",
      mockFetchSequence(incompleteIndex, [])
    );
    const { initCommand } = await loadInitWithDoctor(true);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    captureExit();

    await expect(initCommand({})).rejects.toThrow("process.exit called");
    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("skill_not_found");
    expect(parsed.message).toContain("tranfu-router");
  });

  it("2 runtime + 无 --runtime → runtime_required (7.4 留交互)", async () => {
    mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    mkdirSync(join(tmpHome, ".codex"), { recursive: true });
    const { initCommand } = await loadInitWithDoctor(true);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    captureExit();
    await expect(initCommand({})).rejects.toThrow("process.exit called");
    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("runtime_required");
  });

  it("--runtime=invalid → runtime_invalid", async () => {
    mkdirSync(join(tmpHome, ".claude"), { recursive: true });
    const { initCommand } = await loadInitWithDoctor(true);
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    captureExit();
    await expect(initCommand({ runtime: "vim" })).rejects.toThrow(
      "process.exit called"
    );
    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("runtime_invalid");
  });
});
