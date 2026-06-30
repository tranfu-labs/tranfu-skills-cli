import { describe, it, expect, vi, afterEach } from "vitest";
import type { TfsError } from "../src/types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetModules();
});

// helper: stub `existsSync` 来模拟 runtime 目录是否存在
async function withRuntimeDirs(
  exists: { claude?: boolean; codex?: boolean; hermes?: boolean }
): Promise<typeof import("../src/lib/runtime.js")> {
  vi.resetModules();
  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return {
      ...actual,
      existsSync: (p: string | URL) => {
        const s = String(p);
        if (s.endsWith("/.claude")) return !!exists.claude;
        if (s.endsWith("/.codex")) return !!exists.codex;
        if (s.endsWith("/.hermes")) return !!exists.hermes;
        return actual.existsSync(p);
      },
    };
  });
  return await import("../src/lib/runtime.js");
}

describe("resolveRuntime — explicit value", () => {
  it("explicit claude-code → returns claude-code", async () => {
    const { resolveRuntime } = await withRuntimeDirs({});
    expect(resolveRuntime("claude-code")).toBe("claude-code");
  });

  it("explicit codex → returns codex", async () => {
    const { resolveRuntime } = await withRuntimeDirs({});
    expect(resolveRuntime("codex")).toBe("codex");
  });

  it("explicit invalid → throws runtime_invalid", async () => {
    const { resolveRuntime } = await withRuntimeDirs({ claude: true });
    try {
      resolveRuntime("vim");
      expect.fail("should have thrown");
    } catch (e) {
      const err = e as TfsError;
      expect(err.error).toBe("runtime_invalid");
      expect(err.exit_code).toBe(1);
      expect(err.hint).toContain("claude-code");
      expect(err.hint).toContain("hermes");
    }
  });

  it("explicit hermes → returns hermes", async () => {
    const { resolveRuntime } = await withRuntimeDirs({});
    expect(resolveRuntime("hermes")).toBe("hermes");
  });

  it("explicit even if no dir exists → returns runtime (no validation here)", async () => {
    const { resolveRuntime } = await withRuntimeDirs({});
    // 设计: lib 不校验目录, 调用方 (install/etc) 自己报 permission_denied
    expect(resolveRuntime("codex")).toBe("codex");
  });
});

describe("resolveRuntime — auto-detect", () => {
  it("0 runtime dirs → throws runtime_required with init hint", async () => {
    const { resolveRuntime } = await withRuntimeDirs({});
    try {
      resolveRuntime();
      expect.fail("should have thrown");
    } catch (e) {
      const err = e as TfsError;
      expect(err.error).toBe("runtime_required");
      expect(err.message).toContain("未检测到");
      expect(err.hint).toContain("初始化");
    }
  });

  it("only ~/.claude → returns claude-code silently", async () => {
    const { resolveRuntime } = await withRuntimeDirs({ claude: true });
    expect(resolveRuntime()).toBe("claude-code");
  });

  it("only ~/.codex → returns codex silently", async () => {
    const { resolveRuntime } = await withRuntimeDirs({ codex: true });
    expect(resolveRuntime()).toBe("codex");
  });

  it("only ~/.hermes → returns hermes silently", async () => {
    const { resolveRuntime } = await withRuntimeDirs({ hermes: true });
    expect(resolveRuntime()).toBe("hermes");
  });

  it("both claude+codex → throws runtime_required with --runtime hint", async () => {
    const { resolveRuntime } = await withRuntimeDirs({ claude: true, codex: true });
    try {
      resolveRuntime();
      expect.fail("should have thrown");
    } catch (e) {
      const err = e as TfsError;
      expect(err.error).toBe("runtime_required");
      expect(err.message).toContain("2 个");
      expect(err.hint).toContain("--runtime");
    }
  });

  it("三个都在 → throws runtime_required, 列出 3 个", async () => {
    const { resolveRuntime } = await withRuntimeDirs({
      claude: true,
      codex: true,
      hermes: true,
    });
    try {
      resolveRuntime();
      expect.fail("should have thrown");
    } catch (e) {
      const err = e as TfsError;
      expect(err.error).toBe("runtime_required");
      expect(err.message).toContain("3 个");
      expect(err.message).toContain("hermes");
    }
  });
});

describe("detectAvailableRuntimes", () => {
  it("returns empty when neither dir exists", async () => {
    const { detectAvailableRuntimes } = await withRuntimeDirs({});
    expect(detectAvailableRuntimes()).toEqual([]);
  });

  it("returns all when all three exist (order: claude-code, codex, hermes)", async () => {
    const { detectAvailableRuntimes } = await withRuntimeDirs({
      claude: true,
      codex: true,
      hermes: true,
    });
    expect(detectAvailableRuntimes()).toEqual([
      "claude-code",
      "codex",
      "hermes",
    ]);
  });

  it("only hermes → returns [hermes]", async () => {
    const { detectAvailableRuntimes } = await withRuntimeDirs({ hermes: true });
    expect(detectAvailableRuntimes()).toEqual(["hermes"]);
  });
});

describe("userSkillDir", () => {
  it("claude-code → ~/.claude/skills", async () => {
    const { userSkillDir } = await import("../src/lib/runtime.js");
    expect(userSkillDir("claude-code")).toMatch(/\/\.claude\/skills$/);
  });

  it("codex → ~/.codex/skills", async () => {
    const { userSkillDir } = await import("../src/lib/runtime.js");
    expect(userSkillDir("codex")).toMatch(/\/\.codex\/skills$/);
  });

  it("hermes → ~/.hermes/skills (不含 tranfu 分组, 分组在 resolveTargetPath 加)", async () => {
    const { userSkillDir } = await import("../src/lib/runtime.js");
    expect(userSkillDir("hermes")).toMatch(/\/\.hermes\/skills$/);
  });
});
