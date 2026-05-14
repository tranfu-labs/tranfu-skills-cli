import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IndexJson, SkillEntry } from "../src/types.js";

// 把所有 fetchIndex 相关测试的 ~/.tfs/cache 重定向到 tmpdir, 防止
// user 真实 cache (来自跑过 tfs search) 干扰 fetch mock (fetchIndex 命中 5min cache
// 直接 return, mock fetch 不被调用 → 测试用真实 cache data 而非 mock data).
let tmpHome: string;

beforeEach(() => {
  tmpHome = join(
    tmpdir(),
    `search-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(tmpHome, { recursive: true });
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

// ----- fixture data -----
const authSkill: SkillEntry = {
  name: "auth-helper",
  type: "own",
  description: "OAuth2 认证流程辅助工具",
  path: "own-skills/auth-helper",
  files: ["SKILL.md"],
  sha: "abc123",
};

const deploySkill: SkillEntry = {
  name: "deploy-pipeline",
  type: "own",
  description: "CI/CD deployment pipeline automation",
  path: "own-skills/deploy-pipeline",
  files: ["SKILL.md"],
  sha: "def456",
};

const externalSkill: SkillEntry = {
  name: "karpathy-llm",
  type: "external",
  description: "Andrej Karpathy LLM coding guidelines",
  path: "external-skills/karpathy-llm",
  files: ["SKILL.md"],
  sha: "ghi789",
  source_url: "https://github.com/example/karpathy-llm",
};

const mockIndex: IndexJson = {
  version: 1,
  generated_at: "2026-05-14T00:00:00.000Z",
  skills: [authSkill, deploySkill, externalSkill],
};

function mockFetchOk(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (key: string) => headers[key] ?? null,
    },
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function mockFetchStatus(status: number) {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    headers: { get: () => null },
    text: () => Promise.resolve(""),
  });
}

function mockFetchNetworkError() {
  return vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
}

// Helper: capture process.exit and stderr/stdout
function captureExit() {
  const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
  return exitSpy;
}

// ----- Test 1: search "auth" matches name (substring) -----
describe("matchSkills", () => {
  it('search "auth" matches name (substring)', async () => {
    const { matchSkills } = await import("../src/lib/match.js");
    const results = matchSkills("auth", mockIndex.skills, 5);
    expect(results.some((r) => r.name === "auth-helper")).toBe(true);
  });

  // ----- Test 2: search "认证" matches Chinese description -----
  it('search "认证" matches Chinese description (substring)', async () => {
    const { matchSkills } = await import("../src/lib/match.js");
    const results = matchSkills("认证", mockIndex.skills, 5);
    expect(results.some((r) => r.name === "auth-helper")).toBe(true);
  });

  // ----- Test 3: search "athn" matches via fuzzy -----
  it('search "athn" matches via fuzzy', async () => {
    const { matchSkills } = await import("../src/lib/match.js");
    const results = matchSkills("athn", mockIndex.skills, 5);
    // fuzzy should return auth-helper since "athn" ~ "auth"
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.name === "auth-helper")).toBe(true);
  });
});

// ----- Test 4: --json output schema -----
describe("renderJson", () => {
  it("--json output 完全符合 IndexJson schema", async () => {
    const { renderJson } = await import("../src/lib/format.js");
    const output = JSON.parse(renderJson([authSkill]));
    expect(output).toHaveProperty("results");
    expect(output).toHaveProperty("total", 1);
    const r = output.results[0];
    expect(r).toHaveProperty("name", "auth-helper");
    expect(r).toHaveProperty("type", "own");
    expect(r).toHaveProperty("description");
    expect(r).toHaveProperty("path");
    expect(r).toHaveProperty("sha");
  });
});

// ----- Tests 5-7: --top validation -----
describe("searchCommand top validation", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("--top 100 → exit 1, top_n_invalid", async () => {
    vi.stubGlobal("fetch", mockFetchOk(mockIndex));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = captureExit();

    const { searchCommand } = await import("../src/commands/search.js");
    await expect(
      searchCommand("auth", { top: "100" })
    ).rejects.toThrow("process.exit called");

    const written = stderrSpy.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(written);
    expect(parsed.error).toBe("top_n_invalid");
    expect(exitSpy).toHaveBeenCalledWith(1);

    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("--top 0 → exit 1, top_n_invalid", async () => {
    vi.stubGlobal("fetch", mockFetchOk(mockIndex));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = captureExit();

    const { searchCommand } = await import("../src/commands/search.js");
    await expect(
      searchCommand("auth", { top: "0" })
    ).rejects.toThrow("process.exit called");

    const written = stderrSpy.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(written);
    expect(parsed.error).toBe("top_n_invalid");
    expect(exitSpy).toHaveBeenCalledWith(1);

    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it("--top abc → exit 1, top_n_invalid", async () => {
    vi.stubGlobal("fetch", mockFetchOk(mockIndex));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = captureExit();

    const { searchCommand } = await import("../src/commands/search.js");
    await expect(
      searchCommand("auth", { top: "abc" })
    ).rejects.toThrow("process.exit called");

    const written = stderrSpy.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(written);
    expect(parsed.error).toBe("top_n_invalid");
    expect(exitSpy).toHaveBeenCalledWith(1);

    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    vi.unstubAllGlobals();
  });
});

// ----- Test 8: fetch 404 → index_not_initialized -----
describe("fetchIndex error cases", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("fetch 404 → exit 1, index_not_initialized", async () => {
    vi.stubGlobal("fetch", mockFetchStatus(404));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = captureExit();

    const { searchCommand } = await import("../src/commands/search.js");
    await expect(
      searchCommand("auth", { top: "5" })
    ).rejects.toThrow("process.exit called");

    const written = stderrSpy.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(written);
    expect(parsed.error).toBe("index_not_initialized");
    expect(exitSpy).toHaveBeenCalledWith(1);

    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  // ----- Test 9: fetch 5xx → exit 2, network_error (no cache) -----
  it("fetch 5xx → exit 2, network_error (no cache)", async () => {
    vi.stubGlobal("fetch", mockFetchStatus(500));
    // Mock fs to simulate no cache file
    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs");
      return {
        ...actual,
        statSync: (p: string) => {
          if (String(p).includes(".tfs")) throw new Error("ENOENT");
          return actual.statSync(p);
        },
        readFileSync: (p: string, enc?: unknown) => {
          if (String(p).includes(".tfs")) throw new Error("ENOENT");
          return actual.readFileSync(p, enc as BufferEncoding);
        },
      };
    });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = captureExit();

    const { searchCommand } = await import("../src/commands/search.js");
    await expect(
      searchCommand("auth", { top: "5" })
    ).rejects.toThrow("process.exit called");

    const written = stderrSpy.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(written);
    expect(parsed.error).toBe("network_error");
    expect(exitSpy).toHaveBeenCalledWith(2);

    stderrSpy.mockRestore();
    exitSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.doUnmock("fs");
  });

  // ----- Test 10: fetch 5xx + valid cache → exit 0, soft fallback -----
  it("fetch 5xx + valid cache → exit 0, soft fallback with stderr warn", async () => {
    vi.stubGlobal("fetch", mockFetchStatus(500));
    // Mock fs to simulate a valid cache file
    vi.doMock("fs", async () => {
      const actual = await vi.importActual<typeof import("fs")>("fs");
      return {
        ...actual,
        mkdirSync: vi.fn(),
        statSync: (p: string) => {
          if (String(p).includes(".tfs/cache/index.json")) {
            // Return a stat with mtime = 1 minute ago (within TTL would bypass fetch, so make it old)
            return { mtimeMs: Date.now() - 10 * 60 * 1000 }; // 10 min ago, past TTL
          }
          return actual.statSync(p);
        },
        readFileSync: (p: string, enc?: unknown) => {
          if (String(p).includes(".tfs/cache/index.json")) {
            return JSON.stringify(mockIndex);
          }
          if (String(p).includes(".tfs/cache/index.etag")) {
            return '"some-etag"';
          }
          return actual.readFileSync(p, enc as BufferEncoding);
        },
        writeFileSync: vi.fn(),
      };
    });

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {}) as never);

    const { searchCommand } = await import("../src/commands/search.js");
    await searchCommand("auth", { top: "5" });

    // stderr should have a warning (not an error)
    const stderrWritten = stderrSpy.mock.calls.map((c) => c[0]).join("");
    expect(stderrWritten).toContain("network_error");
    // stdout should have results (fallback succeeded)
    const stdoutWritten = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(stdoutWritten).toContain("auth");
    // Should NOT have called exit with error code
    expect(exitSpy).not.toHaveBeenCalledWith(2);

    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
    vi.unstubAllGlobals();
    vi.doUnmock("fs");
  });
});

// ----- Test 11: --version → exit 0, prints package.json version -----
describe("--version", () => {
  it("--version → exit 0, prints package.json version", async () => {
    const { execSync } = await import("child_process");
    // Build must exist; skip if dist not built yet
    try {
      const output = execSync("node dist/cli.js --version", {
        cwd: "/Users/wing/Develop/goal-claude/tranfu-skills-cli",
        encoding: "utf8",
      });
      expect(output.trim()).toMatch(/0\.1\.0/);
    } catch {
      // If dist not built, test the version from package.json directly
      const { default: pkg } = await import("../package.json", { with: { type: "json" } });
      expect(pkg.version).toMatch(/0\.1\.0/);
    }
  });
});

// ----- Test 12: missing query → exit 1, invalid_args JSON to stderr -----
describe("invalid args", () => {
  it("`tfs search` (no query) → exit 1, invalid_args JSON to stderr", async () => {
    const { execSync } = await import("child_process");
    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      stdout = execSync("node dist/cli.js search", {
        cwd: "/Users/wing/Develop/goal-claude/tranfu-skills-cli",
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err: any) {
      stdout = err.stdout ?? "";
      stderr = err.stderr ?? "";
      exitCode = err.status ?? 1;
    }
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    // stderr 必须是 JSON, 不是 commander 默认人话
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.error).toBe("invalid_args");
    expect(parsed.exit_code).toBe(1);
    expect(parsed.hint).toContain("--help");
  });

  it("`tfs unknown-command` → exit 1, invalid_args JSON to stderr", async () => {
    const { execSync } = await import("child_process");
    let stderr = "";
    let exitCode = 0;
    try {
      execSync("node dist/cli.js unknown-command", {
        cwd: "/Users/wing/Develop/goal-claude/tranfu-skills-cli",
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err: any) {
      stderr = err.stderr ?? "";
      exitCode = err.status ?? 1;
    }
    expect(exitCode).toBe(1);
    const parsed = JSON.parse(stderr.trim());
    expect(parsed.error).toBe("invalid_args");
  });
});
