import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveTargetPath,
  parseScope,
  scopeEquals,
  scopeToString,
  SCOPE_USER,
  SCOPE_PROJECT,
} from "../src/lib/paths.js";
import type { TfsError } from "../src/types.js";

describe("parseScope", () => {
  it("undefined → default user (object)", () => {
    expect(parseScope(undefined)).toEqual({ kind: "user" });
  });

  it("explicit user → {kind:user}", () => {
    expect(parseScope("user")).toEqual({ kind: "user" });
  });

  it("explicit project → {kind:project}", () => {
    expect(parseScope("project")).toEqual({ kind: "project" });
  });

  it("explicit profile:<name> → {kind:profile, name}", () => {
    expect(parseScope("profile:coder")).toEqual({ kind: "profile", name: "coder" });
    expect(parseScope("profile:my-bot_2")).toEqual({
      kind: "profile",
      name: "my-bot_2",
    });
  });

  it("invalid value → throws scope_invalid", () => {
    try {
      parseScope("global");
      expect.fail("should have thrown");
    } catch (e) {
      const err = e as TfsError;
      expect(err.error).toBe("scope_invalid");
      expect(err.message).toContain("user / project / profile:<name>");
      expect(err.exit_code).toBe(1);
    }
  });

  it("profile: 空名 → throws scope_invalid", () => {
    expect(() => parseScope("profile:")).toThrowError();
  });

  it("profile: 含非法字符 (空格 / 斜杠 / ..) → throws scope_invalid", () => {
    expect(() => parseScope("profile:has space")).toThrowError();
    expect(() => parseScope("profile:../etc")).toThrowError();
    expect(() => parseScope("profile:a/b")).toThrowError();
  });

  it("custom default works (e.g. install 默认 user)", () => {
    expect(parseScope(undefined, SCOPE_PROJECT)).toEqual({ kind: "project" });
  });
});

describe("scopeToString / scopeEquals", () => {
  it("scopeToString — user/project/profile", () => {
    expect(scopeToString(SCOPE_USER)).toBe("user");
    expect(scopeToString(SCOPE_PROJECT)).toBe("project");
    expect(scopeToString({ kind: "profile", name: "coder" })).toBe("profile:coder");
  });

  it("scopeEquals — same kind 视为相等; profile 还要 name 相同", () => {
    expect(scopeEquals(SCOPE_USER, { kind: "user" })).toBe(true);
    expect(scopeEquals(SCOPE_USER, SCOPE_PROJECT)).toBe(false);
    expect(
      scopeEquals({ kind: "profile", name: "a" }, { kind: "profile", name: "a" })
    ).toBe(true);
    expect(
      scopeEquals({ kind: "profile", name: "a" }, { kind: "profile", name: "b" })
    ).toBe(false);
    expect(scopeEquals({ kind: "profile", name: "a" }, SCOPE_USER)).toBe(false);
  });
});

describe("resolveTargetPath — user scope", () => {
  it("user + claude-code → ~/.claude/skills", () => {
    const p = resolveTargetPath({ runtime: "claude-code", scope: SCOPE_USER });
    expect(p).toMatch(/\/\.claude\/skills$/);
  });

  it("user + codex → ~/.agents/skills", () => {
    const p = resolveTargetPath({ runtime: "codex", scope: SCOPE_USER });
    expect(p).toMatch(/\/\.agents\/skills$/);
  });

  it("user + hermes → ~/.hermes/skills/tranfu (含分组)", () => {
    const p = resolveTargetPath({ runtime: "hermes", scope: SCOPE_USER });
    expect(p).toMatch(/\/\.hermes\/skills\/tranfu$/);
  });
});

describe("resolveTargetPath — hermes profile scope", () => {
  it("profile:coder → ~/.hermes/profiles/coder/skills/tranfu", () => {
    const p = resolveTargetPath({
      runtime: "hermes",
      scope: { kind: "profile", name: "coder" },
    });
    expect(p).toMatch(/\/\.hermes\/profiles\/coder\/skills\/tranfu$/);
  });

  it("profile:my-bot_2 → 路径含 my-bot_2", () => {
    const p = resolveTargetPath({
      runtime: "hermes",
      scope: { kind: "profile", name: "my-bot_2" },
    });
    expect(p).toMatch(/\/\.hermes\/profiles\/my-bot_2\/skills\/tranfu$/);
  });
});

describe("resolveTargetPath — 非法组合", () => {
  it("hermes + project → scope_unsupported", () => {
    try {
      resolveTargetPath({ runtime: "hermes", scope: SCOPE_PROJECT });
      expect.fail("should have thrown");
    } catch (e) {
      const err = e as TfsError;
      expect(err.error).toBe("scope_unsupported");
      expect(err.message).toContain("hermes");
      expect(err.exit_code).toBe(1);
    }
  });

  it("claude-code + profile → scope_unsupported", () => {
    try {
      resolveTargetPath({
        runtime: "claude-code",
        scope: { kind: "profile", name: "coder" },
      });
      expect.fail("should have thrown");
    } catch (e) {
      const err = e as TfsError;
      expect(err.error).toBe("scope_unsupported");
      expect(err.message).toContain("claude-code");
      expect(err.message).toContain("profile 仅 hermes");
    }
  });

  it("codex + profile → scope_unsupported", () => {
    try {
      resolveTargetPath({
        runtime: "codex",
        scope: { kind: "profile", name: "coder" },
      });
      expect.fail("should have thrown");
    } catch (e) {
      expect((e as TfsError).error).toBe("scope_unsupported");
    }
  });
});

describe("resolveTargetPath — project scope (real git repo)", () => {
  let gitRepo: string;
  let nonGitDir: string;

  beforeEach(() => {
    gitRepo = join(tmpdir(), `paths-test-git-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(gitRepo, { recursive: true });
    execSync("git init -q", { cwd: gitRepo });

    nonGitDir = join(tmpdir(), `paths-test-nongit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(nonGitDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(gitRepo, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(nonGitDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("project + claude-code + 在 git repo → <git-root>/.claude/skills", () => {
    const p = resolveTargetPath({ runtime: "claude-code", scope: SCOPE_PROJECT, cwd: gitRepo });
    expect(p.endsWith("/.claude/skills")).toBe(true);
    expect(p.includes("paths-test-git")).toBe(true);
  });

  it("project + codex + 在 git repo → <git-root>/.agents/skills", () => {
    const p = resolveTargetPath({ runtime: "codex", scope: SCOPE_PROJECT, cwd: gitRepo });
    expect(p.endsWith("/.agents/skills")).toBe(true);
    expect(p.includes("paths-test-git")).toBe(true);
  });

  it("project + 非 git repo → throws git_repo_required", () => {
    try {
      resolveTargetPath({ runtime: "claude-code", scope: SCOPE_PROJECT, cwd: nonGitDir });
      expect.fail("should have thrown");
    } catch (e) {
      const err = e as TfsError;
      expect(err.error).toBe("git_repo_required");
      expect(err.hint).toContain("git repo");
      expect(err.exit_code).toBe(1);
    }
  });

  it("project + 在 git repo 子目录 → 返回 git-root 路径 (不是子目录)", () => {
    const subDir = join(gitRepo, "subpkg", "deep");
    mkdirSync(subDir, { recursive: true });
    const p = resolveTargetPath({ runtime: "claude-code", scope: SCOPE_PROJECT, cwd: subDir });
    expect(p.endsWith("/.claude/skills")).toBe(true);
    expect(p).not.toContain("subpkg");
  });
});
