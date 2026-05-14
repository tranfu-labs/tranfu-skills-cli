import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IndexJson } from "../src/types.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(
    tmpdir(),
    `stale-check-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
  mkdirSync(join(tmpHome, ".claude", "skills"), { recursive: true });
  mkdirSync(join(tmpHome, ".codex", "skills"), { recursive: true });
  vi.resetModules();
  vi.doMock("node:os", async () => {
    const actual = await vi.importActual<typeof import("node:os")>("node:os");
    return { ...actual, homedir: () => tmpHome };
  });
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-14T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("node:os");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

function seedSkill(runtime: "claude" | "codex", name: string, sha: string) {
  const dir = join(tmpHome, `.${runtime}`, "skills", name);
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
# body
`
  );
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
  ],
};

function mockFetchOk(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

const cachePath = () => join(tmpHome, ".tfs", "cache", "last-check.json");

describe("detectOutdatedCached (slice-2 wrapper)", () => {
  it("cache miss → calls detectOutdated, writes cache, cached=false", async () => {
    seedSkill("claude", "skill-a", "old-sha");
    const fetchSpy = mockFetchOk(baseIndex);
    vi.stubGlobal("fetch", fetchSpy);

    const { detectOutdatedCached } = await import("../src/lib/stale-check.js");
    const result = await detectOutdatedCached();

    expect(result.cached).toBe(false);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].status).toBe("outdated");
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // cache 已写
    expect(existsSync(cachePath())).toBe(true);
    const cache = JSON.parse(readFileSync(cachePath(), "utf8"));
    expect(cache).toMatchObject({
      ttl_hours: 6,
      checked_at: "2026-05-14T12:00:00Z",
    });
    expect(cache.skills).toHaveLength(1);
  });

  it("cache hit (<6h) → does NOT call detectOutdated, returns cached=true", async () => {
    seedSkill("claude", "skill-a", "old-sha");
    // 预写 cache, 时间 1h 前
    mkdirSync(join(tmpHome, ".tfs", "cache"), { recursive: true });
    writeFileSync(
      cachePath(),
      JSON.stringify({
        checked_at: "2026-05-14T11:00:00Z",
        ttl_hours: 6,
        skills: [{
          name: "skill-a",
          from: "stale-from",
          to: "stale-to",
          status: "outdated",
          runtime: "claude-code",
        }],
      })
    );
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const { detectOutdatedCached } = await import("../src/lib/stale-check.js");
    const result = await detectOutdatedCached();

    expect(result.cached).toBe(true);
    expect(result.checked_at).toBe("2026-05-14T11:00:00Z");
    expect(result.skills[0].from).toBe("stale-from"); // 来自 cache, 不是 fresh detect
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("cache expired (>6h) → re-fetches, writes new cache", async () => {
    seedSkill("claude", "skill-a", "old-sha");
    mkdirSync(join(tmpHome, ".tfs", "cache"), { recursive: true });
    writeFileSync(
      cachePath(),
      JSON.stringify({
        checked_at: "2026-05-14T05:00:00Z", // 7h 前
        ttl_hours: 6,
        skills: [],
      })
    );
    const fetchSpy = mockFetchOk(baseIndex);
    vi.stubGlobal("fetch", fetchSpy);

    const { detectOutdatedCached } = await import("../src/lib/stale-check.js");
    const result = await detectOutdatedCached();

    expect(result.cached).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // cache 已被覆盖
    const cache = JSON.parse(readFileSync(cachePath(), "utf8"));
    expect(cache.checked_at).toBe("2026-05-14T12:00:00Z");
    expect(cache.skills).toHaveLength(1);
  });

  it("cache corrupted (invalid JSON) → treated as miss, refetches", async () => {
    seedSkill("claude", "skill-a", "old-sha");
    mkdirSync(join(tmpHome, ".tfs", "cache"), { recursive: true });
    writeFileSync(cachePath(), "{not-json");
    const fetchSpy = mockFetchOk(baseIndex);
    vi.stubGlobal("fetch", fetchSpy);

    const { detectOutdatedCached } = await import("../src/lib/stale-check.js");
    const result = await detectOutdatedCached();

    expect(result.cached).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("network fail + no cache → silent degrade, returns empty, cached=false", async () => {
    seedSkill("claude", "skill-a", "old-sha");
    vi.stubGlobal("fetch", () => Promise.reject(new Error("network")));

    const { detectOutdatedCached } = await import("../src/lib/stale-check.js");
    const result = await detectOutdatedCached();

    expect(result.cached).toBe(false);
    expect(result.skills).toEqual([]);
    // 不抛错, 主命令仍能继续
  });

  it("network fail + stale cache → returns stale cache, cached=true", async () => {
    seedSkill("claude", "skill-a", "old-sha");
    mkdirSync(join(tmpHome, ".tfs", "cache"), { recursive: true });
    writeFileSync(
      cachePath(),
      JSON.stringify({
        checked_at: "2026-05-14T00:00:00Z", // 12h 前, expired 但仍可作 fallback
        ttl_hours: 6,
        skills: [{
          name: "skill-a",
          from: "stale-from",
          to: "stale-to",
          status: "outdated",
          runtime: "claude-code",
        }],
      })
    );
    vi.stubGlobal("fetch", () => Promise.reject(new Error("network")));

    const { detectOutdatedCached } = await import("../src/lib/stale-check.js");
    const result = await detectOutdatedCached();

    expect(result.cached).toBe(true);
    expect(result.skills[0].from).toBe("stale-from");
  });

  it("cache file path matches ~/.tfs/cache/last-check.json convention", async () => {
    seedSkill("claude", "skill-a", "old-sha");
    vi.stubGlobal("fetch", mockFetchOk(baseIndex));

    const { detectOutdatedCached } = await import("../src/lib/stale-check.js");
    await detectOutdatedCached();

    expect(existsSync(join(tmpHome, ".tfs", "cache", "last-check.json"))).toBe(true);
  });
});

describe("getStaleHint + staleMarkerLine (piggyback helpers)", () => {
  it("getStaleHint returns null when 0 outdated", async () => {
    seedSkill("claude", "skill-a", "new-sha-a"); // matches index sha → noop
    vi.stubGlobal("fetch", mockFetchOk(baseIndex));

    const { getStaleHint } = await import("../src/lib/stale-check.js");
    const hint = await getStaleHint();

    expect(hint).toBeNull();
  });

  it("getStaleHint returns {outdated_count, names} when N outdated", async () => {
    seedSkill("claude", "skill-a", "old-sha");
    vi.stubGlobal("fetch", mockFetchOk(baseIndex));

    const { getStaleHint } = await import("../src/lib/stale-check.js");
    const hint = await getStaleHint();

    expect(hint).toEqual({ outdated_count: 1, names: ["skill-a"] });
  });

  it("getStaleHint silently degrades on network failure (returns null)", async () => {
    seedSkill("claude", "skill-a", "old-sha");
    vi.stubGlobal("fetch", () => Promise.reject(new Error("network")));

    const { getStaleHint } = await import("../src/lib/stale-check.js");
    const hint = await getStaleHint();

    // 无 cache 时 detectOutdatedCached 返 empty skills → null hint (piggyback 不崩)
    expect(hint).toBeNull();
  });

  it("staleMarkerLine: null hint → empty string", async () => {
    const { staleMarkerLine } = await import("../src/lib/stale-check.js");
    expect(staleMarkerLine(null)).toBe("");
  });

  it("staleMarkerLine: locks prefix '⚠ ' and exact wording (DoD-010)", async () => {
    const { staleMarkerLine } = await import("../src/lib/stale-check.js");
    expect(
      staleMarkerLine({ outdated_count: 1, names: ["a"] })
    ).toMatchInlineSnapshot(`
      "⚠ 1 个 skill 可更新
      "
    `);
    expect(
      staleMarkerLine({ outdated_count: 3, names: ["a", "b", "c"] })
    ).toMatchInlineSnapshot(`
      "⚠ 3 个 skill 可更新
      "
    `);
  });
});
