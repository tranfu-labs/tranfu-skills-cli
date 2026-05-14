import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IndexJson, TfsError } from "../src/types.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(
    tmpdir(),
    `install-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(join(tmpHome, ".claude"), { recursive: true });
  mkdirSync(join(tmpHome, ".codex"), { recursive: true });
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.doUnmock("node:os");
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch { /* ignore */ }
});

const mockIndex: IndexJson = {
  version: 1,
  generated_at: "2026-05-14T00:00:00.000Z",
  skills: [
    {
      name: "auth-helper",
      type: "own",
      description: "OAuth2 帮手",
      path: "own-skills/auth-helper",
      files: ["SKILL.md", "HISTORY.md"],
      sha: "abc123",
    },
    {
      name: "complex-skill",
      type: "external",
      description: "带子目录",
      path: "external-skills/complex-skill",
      files: ["SKILL.md", "_refs/diagram.png", "scripts/helper.sh"],
      sha: "def456",
      source_url: "https://github.com/example/complex",
    },
  ],
};

function mockFetchQueue(bodies: Array<{ body: string; status?: number }>) {
  let i = 0;
  return vi.fn().mockImplementation((url: string) => {
    const r = bodies[i++];
    if (!r) {
      return Promise.reject(
        new Error(`no mock response for fetch #${i - 1} url=${url}`)
      );
    }
    const status = r.status ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      text: () => Promise.resolve(r.body),
    });
  });
}

async function loadInstallWithHome() {
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return { ...actual, homedir: () => tmpHome };
  });
  return await import("../src/commands/install.js");
}

function captureExit() {
  return vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
}

describe("install — happy path", () => {
  it("装一个 skill 到 ~/.claude/skills/, 文件齐 + stamp 完整", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchQueue([
        { body: JSON.stringify(mockIndex) },
        { body: "---\nname: auth-helper\ndescription: foo\n---\n# body" },
        { body: "history\n" },
      ])
    );
    const { installCommand } = await loadInstallWithHome();
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await installCommand("auth-helper", {
      scope: "user",
      runtime: "claude-code",
    });

    const targetDir = join(tmpHome, ".claude", "skills", "auth-helper");
    expect(existsSync(targetDir)).toBe(true);
    expect(existsSync(join(targetDir, "SKILL.md"))).toBe(true);
    expect(existsSync(join(targetDir, "HISTORY.md"))).toBe(true);

    const md = readFileSync(join(targetDir, "SKILL.md"), "utf8");
    expect(md).toContain("installed_by: tranfu-skills");
    expect(md).toContain("installed_version: abc123");
    expect(md).toContain("installed_source: own");
    expect(md).toMatch(/installed_at: \d{4}-\d{2}-\d{2}/);

    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("✓ installed auth-helper");
    expect(out).toContain("Restart Claude Code");
  });

  it("装到 ~/.codex/skills/ (--runtime=codex)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchQueue([
        { body: JSON.stringify(mockIndex) },
        { body: "---\nname: auth-helper\ndescription: foo\n---\n" },
        { body: "" },
      ])
    );
    const { installCommand } = await loadInstallWithHome();
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await installCommand("auth-helper", { scope: "user", runtime: "codex" });

    expect(existsSync(join(tmpHome, ".codex", "skills", "auth-helper"))).toBe(
      true
    );
    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("Restart Codex CLI");
  });

  it("处理 files 含子目录 (_refs/, scripts/)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchQueue([
        { body: JSON.stringify(mockIndex) },
        { body: "---\nname: complex\ndescription: foo\n---" },
        { body: "PNG-DATA" },
        { body: "#!/bin/bash\n" },
      ])
    );
    const { installCommand } = await loadInstallWithHome();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await installCommand("complex-skill", {
      scope: "user",
      runtime: "claude-code",
    });

    const targetDir = join(tmpHome, ".claude", "skills", "complex-skill");
    expect(existsSync(join(targetDir, "_refs", "diagram.png"))).toBe(true);
    expect(existsSync(join(targetDir, "scripts", "helper.sh"))).toBe(true);
  });

  it("--scope=project + git repo → 装到 git-root/.claude/skills", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchQueue([
        { body: JSON.stringify(mockIndex) },
        { body: "---\nname: auth\ndescription: foo\n---" },
        { body: "" },
      ])
    );
    const gitRoot = join(tmpHome, "myproject");
    mkdirSync(gitRoot, { recursive: true });
    execSync("git init -q", { cwd: gitRoot });
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(gitRoot);

    const { installCommand } = await loadInstallWithHome();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await installCommand("auth-helper", {
      scope: "project",
      runtime: "claude-code",
    });

    expect(
      existsSync(join(gitRoot, ".claude", "skills", "auth-helper"))
    ).toBe(true);
    cwdSpy.mockRestore();
  });
});

describe("install — error cases", () => {
  it("skill 不在 index → exit 1 skill_not_found", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchQueue([{ body: JSON.stringify(mockIndex) }])
    );
    const { installCommand } = await loadInstallWithHome();
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const exitSpy = captureExit();

    await expect(
      installCommand("nonexistent", { scope: "user", runtime: "claude-code" })
    ).rejects.toThrow("process.exit called");

    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("skill_not_found");
    expect(parsed.hint).toContain("tfs search");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("Phase 3.3: 无戳目录 + --force → rm 旧 + 装新 + 戳完整", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchQueue([
        { body: JSON.stringify(mockIndex) },
        { body: "---\nname: auth-helper\ndescription: foo\n---\n# fresh body" },
        { body: "fresh history\n" },
      ])
    );
    // pre-seed 无戳的同名目录 (e.g. 用户手装)
    const targetDir = join(tmpHome, ".claude", "skills", "auth-helper");
    mkdirSync(targetDir, { recursive: true });
    require("node:fs").writeFileSync(
      join(targetDir, "SKILL.md"),
      "---\nname: auth-helper\ndescription: handmade\n---\n# old body\n"
    );
    require("node:fs").writeFileSync(
      join(targetDir, "stale-file.txt"),
      "should be gone after --force"
    );

    const { installCommand } = await loadInstallWithHome();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await installCommand("auth-helper", {
      scope: "user",
      runtime: "claude-code",
      force: true,
    });

    // 旧文件不存在, 新装完整
    expect(existsSync(join(targetDir, "stale-file.txt"))).toBe(false);
    expect(existsSync(join(targetDir, "HISTORY.md"))).toBe(true);
    const md = readFileSync(join(targetDir, "SKILL.md"), "utf8");
    expect(md).toContain("installed_by: tranfu-skills");
    expect(md).toContain("# fresh body");
    expect(md).not.toContain("# old body");
  });

  it("Phase 3.3: 无戳目录 + 无 --force → skill_already_installed (hint 含 --force)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchQueue([{ body: JSON.stringify(mockIndex) }])
    );
    mkdirSync(join(tmpHome, ".claude", "skills", "auth-helper"), {
      recursive: true,
    });
    const { installCommand } = await loadInstallWithHome();
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    captureExit();

    await expect(
      installCommand("auth-helper", { scope: "user", runtime: "claude-code" })
    ).rejects.toThrow("process.exit called");

    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("skill_already_installed");
    expect(parsed.message).toContain("stamp: absent");
    expect(parsed.hint).toContain("--force");
  });

  it("Phase 3.4: 半残戳 (缺 installed_version) + --force → 重写完整", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchQueue([
        { body: JSON.stringify(mockIndex) },
        { body: "---\nname: auth-helper\ndescription: foo\n---\n# fresh" },
        { body: "fresh history\n" },
      ])
    );
    const targetDir = join(tmpHome, ".claude", "skills", "auth-helper");
    mkdirSync(targetDir, { recursive: true });
    // 半残戳: 有 installed_by 但缺 installed_version
    require("node:fs").writeFileSync(
      join(targetDir, "SKILL.md"),
      `---
name: auth-helper
description: corrupt
installed_by: tranfu-skills
installed_at: 2026-01-01
installed_source: own
---
# corrupt body
`
    );
    const { installCommand } = await loadInstallWithHome();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    await installCommand("auth-helper", {
      scope: "user",
      runtime: "claude-code",
      force: true,
    });
    // 重写: 新 stamp 完整, 旧 corrupt body 没了
    const md = readFileSync(join(targetDir, "SKILL.md"), "utf8");
    expect(md).toContain("installed_version: abc123");  // 新 sha 写上了
    expect(md).toContain("# fresh");
    expect(md).not.toContain("# corrupt body");
  });

  it("Phase 3.4: 半残戳 + 无 --force → skill_already_installed (hint 提示 partial)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchQueue([{ body: JSON.stringify(mockIndex) }])
    );
    const targetDir = join(tmpHome, ".claude", "skills", "auth-helper");
    mkdirSync(targetDir, { recursive: true });
    require("node:fs").writeFileSync(
      join(targetDir, "SKILL.md"),
      `---
installed_by: tranfu-skills
installed_at: 2026-01-01
---
`
    );
    const { installCommand } = await loadInstallWithHome();
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    captureExit();
    await expect(
      installCommand("auth-helper", { scope: "user", runtime: "claude-code" })
    ).rejects.toThrow("process.exit called");
    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("skill_already_installed");
    expect(parsed.message).toContain("stamp: partial");
    expect(parsed.hint).toContain("不完整的安装戳");
    expect(parsed.hint).toContain("--force");
  });

  it("Phase 3.3: 有 intact 戳 + --force → 仍 skill_already_installed (3.5 才处理)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchQueue([{ body: JSON.stringify(mockIndex) }])
    );
    const targetDir = join(tmpHome, ".claude", "skills", "auth-helper");
    mkdirSync(targetDir, { recursive: true });
    require("node:fs").writeFileSync(
      join(targetDir, "SKILL.md"),
      `---
name: auth-helper
description: prev install
installed_by: tranfu-skills
installed_version: old-sha
installed_at: 2026-01-01
installed_source: own
---
`
    );
    const { installCommand } = await loadInstallWithHome();
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    captureExit();

    await expect(
      installCommand("auth-helper", {
        scope: "user",
        runtime: "claude-code",
        force: true,
      })
    ).rejects.toThrow("process.exit called");

    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("skill_already_installed");
    expect(parsed.message).toContain("stamp: intact");
    expect(parsed.hint).toContain("3.5");  // 提示 update/noop 留 3.5
  });

  it("Phase 3.3: renameSync 抛 plain Error → 走 internal_error (修 3.2 留的 cast bug)", async () => {
    // 此 case 模拟 fs renameSync 抛 plain Error (e.g. EXDEV cross-device).
    // 不依赖真实 fs error, 只依赖 install.ts catch 块逻辑 — 用一个非 TfsError shape 的对象触发.
    vi.stubGlobal(
      "fetch",
      mockFetchQueue([
        { body: JSON.stringify(mockIndex) },
        { body: "---\nname: foo\n---" },
        { body: "" },
      ])
    );
    // 用 vi.doMock 拦截 fs renameSync 让它抛
    vi.doMock("node:fs", async () => {
      const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
      return {
        ...actual,
        renameSync: () => {
          throw new Error("EXDEV: cross-device link not permitted");
        },
      };
    });
    const { installCommand } = await loadInstallWithHome();
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const exitSpy = captureExit();

    await expect(
      installCommand("auth-helper", { scope: "user", runtime: "claude-code" })
    ).rejects.toThrow("process.exit called");

    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("internal_error");
    expect(parsed.message).toContain("EXDEV");
    expect(exitSpy).toHaveBeenCalledWith(3);
    vi.doUnmock("node:fs");
  });

  it("target 目录已存在 → exit 1 skill_already_installed (含 --force hint)", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchQueue([{ body: JSON.stringify(mockIndex) }])
    );
    mkdirSync(join(tmpHome, ".claude", "skills", "auth-helper"), {
      recursive: true,
    });
    const { installCommand } = await loadInstallWithHome();
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const exitSpy = captureExit();

    await expect(
      installCommand("auth-helper", { scope: "user", runtime: "claude-code" })
    ).rejects.toThrow("process.exit called");

    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("skill_already_installed");
    expect(parsed.hint).toContain("--force");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("--runtime invalid → exit 1 runtime_invalid", async () => {
    const { installCommand } = await loadInstallWithHome();
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    captureExit();

    await expect(
      installCommand("foo", { scope: "user", runtime: "vim" })
    ).rejects.toThrow("process.exit called");

    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("runtime_invalid");
  });

  it("--scope invalid → exit 1 scope_invalid", async () => {
    const { installCommand } = await loadInstallWithHome();
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    captureExit();

    await expect(
      installCommand("foo", { scope: "global", runtime: "claude-code" })
    ).rejects.toThrow("process.exit called");

    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("scope_invalid");
  });

  it("--scope project + 非 git repo → exit 1 git_repo_required", async () => {
    const { installCommand } = await loadInstallWithHome();
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    captureExit();
    const nonGit = join(tmpHome, "nongit");
    mkdirSync(nonGit);
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(nonGit);

    await expect(
      installCommand("foo", { scope: "project", runtime: "claude-code" })
    ).rejects.toThrow("process.exit called");

    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("git_repo_required");
    cwdSpy.mockRestore();
  });

  it("Phase 3.2: 文件 fetch 中途失败 → staging 清理 + targetDir 不存在 + network_error", async () => {
    let callIdx = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        callIdx++;
        if (callIdx === 1) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: { get: () => null },
            text: () => Promise.resolve(JSON.stringify(mockIndex)),
          });
        }
        if (callIdx === 2) {
          // SKILL.md fetch OK
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: { get: () => null },
            text: () => Promise.resolve("---\nname: foo\n---"),
          });
        }
        // 第 3 次 (HISTORY.md) 失败
        return Promise.reject(new Error("ENETDOWN"));
      })
    );
    const { installCommand } = await loadInstallWithHome();
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const exitSpy = captureExit();

    await expect(
      installCommand("auth-helper", { scope: "user", runtime: "claude-code" })
    ).rejects.toThrow("process.exit called");

    const targetDir = join(tmpHome, ".claude", "skills", "auth-helper");
    const stagingDir = join(
      tmpHome,
      ".claude",
      "skills",
      ".tfs-staging",
      "auth-helper"
    );
    expect(existsSync(targetDir)).toBe(false); // 关键: target 不被部分写入
    expect(existsSync(stagingDir)).toBe(false); // staging 已清理

    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("network_error");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });

  it("Phase 3.2: 上次失败残留的 staging → 自动清理 + 重装成功", async () => {
    // pre-seed 上次失败的 staging 残留
    const skillsDir = join(tmpHome, ".claude", "skills");
    mkdirSync(join(skillsDir, ".tfs-staging", "auth-helper", "junk"), {
      recursive: true,
    });
    // 写一个垃圾文件确认残留确实存在
    const junkFile = join(skillsDir, ".tfs-staging", "auth-helper", "junk", "stale.txt");
    require("node:fs").writeFileSync(junkFile, "stale data");
    expect(existsSync(junkFile)).toBe(true);

    vi.stubGlobal(
      "fetch",
      mockFetchQueue([
        { body: JSON.stringify(mockIndex) },
        { body: "---\nname: auth-helper\ndescription: foo\n---" },
        { body: "history\n" },
      ])
    );
    const { installCommand } = await loadInstallWithHome();
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await installCommand("auth-helper", {
      scope: "user",
      runtime: "claude-code",
    });

    // 残留垃圾被清掉, 新安装成功
    expect(existsSync(junkFile)).toBe(false);
    expect(existsSync(join(skillsDir, "auth-helper", "SKILL.md"))).toBe(true);
    expect(existsSync(join(skillsDir, ".tfs-staging", "auth-helper"))).toBe(
      false
    );  // staging rename 后已消失
  });

  it("文件 fetch 网络错 → exit 2 network_error (atomic: target 不存在)", async () => {
    let callIdx = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => {
        callIdx++;
        if (callIdx === 1) {
          return Promise.resolve({
            ok: true,
            status: 200,
            headers: { get: () => null },
            text: () => Promise.resolve(JSON.stringify(mockIndex)),
          });
        }
        return Promise.reject(new Error("ENETDOWN"));
      })
    );
    const { installCommand } = await loadInstallWithHome();
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const exitSpy = captureExit();

    await expect(
      installCommand("auth-helper", { scope: "user", runtime: "claude-code" })
    ).rejects.toThrow("process.exit called");

    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("network_error");
    expect(exitSpy).toHaveBeenCalledWith(2);
  });
});
