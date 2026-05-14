import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTargetPath, parseScope } from "../src/lib/paths.js";
import type { TfsError } from "../src/types.js";

describe("parseScope", () => {
  it("undefined → default user", () => {
    expect(parseScope(undefined)).toBe("user");
  });

  it("explicit user → user", () => {
    expect(parseScope("user")).toBe("user");
  });

  it("explicit project → project", () => {
    expect(parseScope("project")).toBe("project");
  });

  it("invalid value → throws scope_invalid", () => {
    try {
      parseScope("global");
      expect.fail("should have thrown");
    } catch (e) {
      const err = e as TfsError;
      expect(err.error).toBe("scope_invalid");
      expect(err.message).toContain("user 或 project");
      expect(err.exit_code).toBe(1);
    }
  });

  it("custom default works (e.g. install 默认 user)", () => {
    expect(parseScope(undefined, "user")).toBe("user");
  });
});

describe("resolveTargetPath — user scope", () => {
  it("user + claude-code → ~/.claude/skills", () => {
    const p = resolveTargetPath({ runtime: "claude-code", scope: "user" });
    expect(p).toMatch(/\/\.claude\/skills$/);
  });

  it("user + codex → ~/.codex/skills", () => {
    const p = resolveTargetPath({ runtime: "codex", scope: "user" });
    expect(p).toMatch(/\/\.codex\/skills$/);
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
    const p = resolveTargetPath({ runtime: "claude-code", scope: "project", cwd: gitRepo });
    // macOS tmpdir 可能是 /private/var/... 而 git rev-parse 返回 /var/... — 用 endsWith 容错
    expect(p.endsWith("/.claude/skills")).toBe(true);
    expect(p.includes("paths-test-git")).toBe(true);
  });

  it("project + codex + 在 git repo → <git-root>/.codex/skills", () => {
    const p = resolveTargetPath({ runtime: "codex", scope: "project", cwd: gitRepo });
    expect(p.endsWith("/.codex/skills")).toBe(true);
    expect(p.includes("paths-test-git")).toBe(true);
  });

  it("project + 非 git repo → throws git_repo_required", () => {
    try {
      resolveTargetPath({ runtime: "claude-code", scope: "project", cwd: nonGitDir });
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
    const p = resolveTargetPath({ runtime: "claude-code", scope: "project", cwd: subDir });
    expect(p.endsWith("/.claude/skills")).toBe(true);
    expect(p).not.toContain("subpkg");  // 锁定 V3 变更 8 行为: 首版不支持子包级
  });
});
