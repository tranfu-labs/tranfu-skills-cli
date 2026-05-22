import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  _checkNodeVersionFromString,
  _checkRuntimeFromList,
  _checkTfsInPath,
  _checkLegacyCachePaths,
  runDoctor,
} from "../src/lib/doctor.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

function captureExit() {
  return vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
}

describe("doctor SDK — Node version check", () => {
  it("Node 20 → status=ok, fatal=true", () => {
    const r = _checkNodeVersionFromString("20.10.0");
    expect(r.name).toBe("node-version");
    expect(r.status).toBe("ok");
    expect(r.fatal).toBe(true);
    expect(r.message).toContain("20.10.0");
  });

  it("Node 22 → status=ok (任何 >=20 major)", () => {
    expect(_checkNodeVersionFromString("22.0.0").status).toBe("ok");
  });

  it("Node 18 → status=fail, fatal=true (太老)", () => {
    const r = _checkNodeVersionFromString("18.19.0");
    expect(r.status).toBe("fail");
    expect(r.fatal).toBe(true);
    expect(r.message).toContain("太老");
    expect(r.message).toContain("18.19.0");
  });

  it("Node 16 → status=fail", () => {
    expect(_checkNodeVersionFromString("16.20.0").status).toBe("fail");
  });

  it("Node 20.0.0-rc 等预发版 → status=ok (parseInt 取 major)", () => {
    expect(_checkNodeVersionFromString("20.0.0-rc.1").status).toBe("ok");
  });

  it("非法版本 string → status=fail", () => {
    const r = _checkNodeVersionFromString("bogus");
    expect(r.status).toBe("fail");
    expect(r.message).toContain("无法解析");
  });
});

describe("doctor SDK — runtime check (6.3)", () => {
  it("0 runtime → fail, fatal=true", () => {
    const r = _checkRuntimeFromList([]);
    expect(r.status).toBe("fail");
    expect(r.fatal).toBe(true);
    expect(r.message).toContain("未检测到");
  });

  it("1 runtime → ok, fatal=true, message 含名字", () => {
    const r = _checkRuntimeFromList(["claude-code"]);
    expect(r.status).toBe("ok");
    expect(r.fatal).toBe(true);
    expect(r.message).toContain("claude-code");
  });

  it("2 runtime → ok (列出两个)", () => {
    const r = _checkRuntimeFromList(["claude-code", "codex"]);
    expect(r.status).toBe("ok");
    expect(r.message).toContain("claude-code");
    expect(r.message).toContain("codex");
  });
});

describe("doctor SDK — tfs-in-path check (6.4)", () => {
  it("which tfs 找不到 → warn (非 fatal)", () => {
    const r = _checkTfsInPath(null, "/usr/local/bin/node");
    expect(r.status).toBe("warn");
    expect(r.fatal).toBe(false);
    expect(r.message).toContain("不在 PATH");
  });

  it("tfs 在 node 同目录 → ok", () => {
    const r = _checkTfsInPath(
      "/Users/x/.fnm/versions/v20/bin/tfs",
      "/Users/x/.fnm/versions/v20/bin/node"
    );
    expect(r.status).toBe("ok");
    expect(r.message).toContain(".fnm/versions/v20/bin/tfs");
  });

  it("tfs 跟 node 不同目录 → warn (fnm 切版本风险)", () => {
    const r = _checkTfsInPath(
      "/Users/x/.fnm/versions/v18/bin/tfs",
      "/Users/x/.fnm/versions/v20/bin/node"
    );
    expect(r.status).toBe("warn");
    expect(r.fatal).toBe(false);
    expect(r.message).toContain("fnm");
  });
});

describe("doctor SDK — legacy-cache check (6.5)", () => {
  it("无旧缓存 → ok", () => {
    const r = _checkLegacyCachePaths([]);
    expect(r.status).toBe("ok");
    expect(r.message).toContain("无旧版");
  });

  it("有 1 个旧路径 → warn (非 fatal)", () => {
    const r = _checkLegacyCachePaths(["/Users/x/.tranfu-labs/tranfu-skills"]);
    expect(r.status).toBe("warn");
    expect(r.fatal).toBe(false);
    expect(r.message).toContain("tranfu-skills");
    expect(r.message).toContain("可手动 rm");
  });

  it("有多个旧路径 → warn 列出全部", () => {
    const r = _checkLegacyCachePaths([
      "/Users/x/.aistore-labs/claude-skills",
      "/Users/x/.tranfu-labs/claude-skills",
    ]);
    expect(r.status).toBe("warn");
    expect(r.message).toContain("aistore-labs");
    expect(r.message).toContain("tranfu-labs");
  });
});

describe("runDoctor() SDK (集成)", () => {
  it("返回 {checks, ok} 结构, checks 含 4 个", () => {
    const r = runDoctor();
    expect(r).toHaveProperty("checks");
    expect(r).toHaveProperty("ok");
    expect(r.checks).toHaveLength(4);
    const names = r.checks.map((c) => c.name);
    expect(names).toEqual([
      "node-version",
      "runtime",
      "tfs-in-path",
      "legacy-cache",
    ]);
  });

  it("当前进程跑 → node-version=ok (因为 Node>=20 才能跑测试)", () => {
    const r = runDoctor();
    expect(r.checks.find((c) => c.name === "node-version")?.status).toBe("ok");
  });

  it("ok 字段语义: 所有 fatal check 都 ok", () => {
    const r = runDoctor();
    const fatalFails = r.checks.filter(
      (c) => c.fatal && c.status !== "ok"
    );
    expect(r.ok).toBe(fatalFails.length === 0);
  });
});

describe("doctor CLI (commands/doctor.ts)", () => {
  it("全 ok → 输出 ✓ 行 + 'All checks passed.'", async () => {
    vi.doMock("../src/lib/doctor.js", () => ({
      runDoctor: () => ({
        checks: [
          {
            name: "node-version",
            status: "ok",
            message: "Node 20.0.0 (>= 20)",
            fatal: true,
          },
        ],
        ok: true,
      }),
    }));
    vi.doMock("../src/lib/stale-check.js", () => ({
      detectOutdatedCached: vi.fn().mockResolvedValue({
        skills: [],
        checked_at: "2026-05-14T00:00:00Z",
        cached: false,
      }),
    }));
    const { doctorCommand } = await import("../src/commands/doctor.js");
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await doctorCommand({});

    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("✓ node-version");
    expect(out).toContain("All checks passed");
  });

  it("fatal fail → 输出 ✗ + 提示 + exit 1", async () => {
    vi.doMock("../src/lib/doctor.js", () => ({
      runDoctor: () => ({
        checks: [
          {
            name: "node-version",
            status: "fail",
            message: "Node 18 太老",
            fatal: true,
          },
        ],
        ok: false,
      }),
    }));
    const { doctorCommand } = await import("../src/commands/doctor.js");
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    const exitSpy = captureExit();

    await expect(doctorCommand({})).rejects.toThrow("process.exit called");
    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("✗ node-version");
    expect(out).toContain("Fatal check(s) failed");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("仅 warn (无 fail) → exit 0 + 'N warning(s)'", async () => {
    vi.doMock("../src/lib/doctor.js", () => ({
      runDoctor: () => ({
        checks: [
          {
            name: "node-version",
            status: "ok",
            message: "Node 20",
            fatal: true,
          },
          {
            name: "gh-auth",
            status: "warn",
            message: "gh 未登录",
            fatal: false,
          },
        ],
        ok: true, // fatal 都 OK
      }),
    }));
    vi.doMock("../src/lib/stale-check.js", () => ({
      detectOutdatedCached: vi.fn().mockResolvedValue({
        skills: [],
        checked_at: "2026-05-14T00:00:00Z",
        cached: false,
      }),
    }));
    const { doctorCommand } = await import("../src/commands/doctor.js");
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await doctorCommand({});

    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("⚠ gh-auth");
    expect(out).toContain("1 warning(s)");
    expect(out).not.toContain("All checks passed");
  });
});

describe("doctor — skills-up-to-date check + --json", () => {
  it("outdated > 0 → ⚠ skills-up-to-date check, message 含 'tfs update', warning 计数包含它", async () => {
    vi.doMock("../src/lib/doctor.js", () => ({
      runDoctor: () => ({
        checks: [{ name: "node-version", status: "ok", message: "ok", fatal: true }],
        ok: true,
      }),
    }));
    vi.doMock("../src/lib/stale-check.js", () => ({
      detectOutdatedCached: vi.fn().mockResolvedValue({
        skills: [
          { name: "a", from: "x", to: "x", status: "noop", runtime: "claude-code" },
          { name: "b", from: "x", to: "y", status: "outdated", runtime: "claude-code" },
        ],
        checked_at: "2026-05-14T00:00:00Z",
        cached: false,
      }),
    }));
    const { doctorCommand } = await import("../src/commands/doctor.js");
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await doctorCommand({});

    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("⚠ skills-up-to-date:");
    expect(out).toMatch(/已装 2 个 skill, 1 个 outdated/);
    expect(out).toContain("tfs update");
    expect(out).toContain("1 warning(s)");
    expect(out).not.toContain("All checks passed");
  });

  it("0 outdated → ✓ skills-up-to-date check, 不带 'tfs update' / 'outdated' 词", async () => {
    vi.doMock("../src/lib/doctor.js", () => ({
      runDoctor: () => ({
        checks: [{ name: "node-version", status: "ok", message: "ok", fatal: true }],
        ok: true,
      }),
    }));
    vi.doMock("../src/lib/stale-check.js", () => ({
      detectOutdatedCached: vi.fn().mockResolvedValue({
        skills: [
          { name: "a", from: "x", to: "x", status: "noop", runtime: "claude-code" },
        ],
        checked_at: "2026-05-14T00:00:00Z",
        cached: false,
      }),
    }));
    const { doctorCommand } = await import("../src/commands/doctor.js");
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await doctorCommand({});

    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("✓ skills-up-to-date:");
    expect(out).toMatch(/已装 1 个 skill/);
    expect(out).not.toMatch(/outdated/);
    expect(out).not.toContain("tfs update");
    expect(out).toContain("All checks passed");
  });

  it("--json 输出 {checks, ok, installed_count, outdated_count}", async () => {
    vi.doMock("../src/lib/doctor.js", () => ({
      runDoctor: () => ({
        checks: [{ name: "node-version", status: "ok", message: "ok", fatal: true }],
        ok: true,
      }),
    }));
    vi.doMock("../src/lib/stale-check.js", () => ({
      detectOutdatedCached: vi.fn().mockResolvedValue({
        skills: [
          { name: "a", from: "x", to: "y", status: "outdated", runtime: "claude-code" },
          { name: "b", from: "x", to: "x", status: "noop", runtime: "claude-code" },
        ],
        checked_at: "2026-05-14T00:00:00Z",
        cached: false,
      }),
    }));
    const { doctorCommand } = await import("../src/commands/doctor.js");
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await doctorCommand({ json: true });

    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.installed_count).toBe(2);
    expect(parsed.outdated_count).toBe(1);
    expect(Array.isArray(parsed.checks)).toBe(true);
    // skills-up-to-date 作为 5 项里的第 5 项 (mock 只给 1 项 → 这里是 2 项)
    const upToDate = parsed.checks.find(
      (c: { name: string }) => c.name === "skills-up-to-date"
    );
    expect(upToDate).toBeDefined();
    expect(upToDate.status).toBe("warn");
    expect(upToDate.fatal).toBe(false);
  });

  it("detection silent fail → installed/outdated count = 0, doctor still 跑完", async () => {
    vi.doMock("../src/lib/doctor.js", () => ({
      runDoctor: () => ({
        checks: [{ name: "node-version", status: "ok", message: "ok", fatal: true }],
        ok: true,
      }),
    }));
    vi.doMock("../src/lib/stale-check.js", () => ({
      detectOutdatedCached: vi.fn().mockRejectedValue(new Error("network")),
    }));
    const { doctorCommand } = await import("../src/commands/doctor.js");
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await doctorCommand({ json: true });

    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(true);
    expect(parsed.installed_count).toBe(0);
    expect(parsed.outdated_count).toBe(0);
    // detection 挂 → 不追加 skills-up-to-date check, 回到 4 项 (mock 只给 1 → 这里 1)
    const upToDate = parsed.checks.find(
      (c: { name: string }) => c.name === "skills-up-to-date"
    );
    expect(upToDate).toBeUndefined();
  });
});
