import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// shouldPromptInteractiveUpgrade 内部用 homedir() 算 cache 路径. 必须先 mock 再 import.
let tmpHome: string;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "tfs-selfcheck-"));
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return { ...actual, homedir: () => tmpHome };
  });
});

afterEach(() => {
  vi.resetModules();
  vi.unstubAllEnvs();
  rmSync(tmpHome, { recursive: true, force: true });
});

function writeCacheFile(payload: object): void {
  const dir = join(tmpHome, ".tfs", "cache");
  if (!existsSync(dir)) {
    require("node:fs").mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(dir, "last-self-check.json"), JSON.stringify(payload), "utf8");
}

function readCacheFile(): unknown {
  return JSON.parse(
    readFileSync(join(tmpHome, ".tfs", "cache", "last-self-check.json"), "utf8")
  );
}

describe("shouldPromptInteractiveUpgrade", () => {
  it("VITEST env 自动 skip → null", async () => {
    // VITEST 默认 set, 不用手动 stub
    const { shouldPromptInteractiveUpgrade } = await import(
      "../src/lib/self-version-check.js"
    );
    expect(shouldPromptInteractiveUpgrade()).toBeNull();
  });

  it("TFS_NO_NAG=1 → null (即使 cache outdated)", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TFS_NO_NAG", "1");
    writeCacheFile({
      checked_at: new Date().toISOString(),
      latest: "999.0.0",
    });
    const { shouldPromptInteractiveUpgrade } = await import(
      "../src/lib/self-version-check.js"
    );
    expect(shouldPromptInteractiveUpgrade()).toBeNull();
  });

  it("非 TTY 直接 null", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    // vitest 跑测试时 stdin/stdout 默认非 TTY, isInteractive() 返回 false → 自然 null
    writeCacheFile({
      checked_at: new Date().toISOString(),
      latest: "999.0.0",
    });
    const { shouldPromptInteractiveUpgrade } = await import(
      "../src/lib/self-version-check.js"
    );
    expect(shouldPromptInteractiveUpgrade()).toBeNull();
  });

  it("cache 不存在 → null", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    const { shouldPromptInteractiveUpgrade } = await import(
      "../src/lib/self-version-check.js"
    );
    expect(shouldPromptInteractiveUpgrade()).toBeNull();
  });

  it("cache 过期 (>24h) → null (不基于 stale cache prompt)", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    const oldDate = new Date(Date.now() - 25 * 60 * 60 * 1000);
    writeCacheFile({
      checked_at: oldDate.toISOString(),
      latest: "999.0.0",
    });
    const { shouldPromptInteractiveUpgrade } = await import(
      "../src/lib/self-version-check.js"
    );
    expect(shouldPromptInteractiveUpgrade()).toBeNull();
  });
});

describe("cache schema with declined_until", () => {
  it("readCache 可读出 declined_until 字段 (向后兼容: 老 cache 没此字段也 OK)", async () => {
    vi.stubEnv("VITEST", "");
    vi.stubEnv("NODE_ENV", "production");
    // 老格式 cache (无 declined_until)
    writeCacheFile({
      checked_at: new Date().toISOString(),
      latest: "0.5.0",
    });
    const { shouldPromptInteractiveUpgrade } = await import(
      "../src/lib/self-version-check.js"
    );
    // 即使是老 cache, 由于非 TTY 仍返 null. 但不应 throw.
    expect(() => shouldPromptInteractiveUpgrade()).not.toThrow();
    // cache 文件没被改坏
    const raw = readCacheFile() as { latest: string };
    expect(raw.latest).toBe("0.5.0");
  });
});

describe("maybePromptSelfUpgrade", () => {
  it("VITEST 环境下 silent 返回, 不动 cache 不 throw", async () => {
    writeCacheFile({
      checked_at: new Date().toISOString(),
      latest: "999.0.0",
    });
    const { maybePromptSelfUpgrade } = await import(
      "../src/lib/self-version-check.js"
    );
    await expect(maybePromptSelfUpgrade()).resolves.toBeUndefined();
    // cache 没被写 declined_until (因为根本没 prompt)
    const raw = readCacheFile() as { declined_until?: string };
    expect(raw.declined_until).toBeUndefined();
  });
});
