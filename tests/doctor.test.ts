import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { _checkNodeVersionFromString, runDoctor } from "../src/lib/doctor.js";

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

describe("runDoctor() SDK", () => {
  it("返回 {checks, ok} 结构", () => {
    const r = runDoctor();
    expect(r).toHaveProperty("checks");
    expect(r).toHaveProperty("ok");
    expect(Array.isArray(r.checks)).toBe(true);
  });

  it("当前进程跑 → 必须 ok=true (因为 Node>=20 才能运行测试)", () => {
    const r = runDoctor();
    expect(r.ok).toBe(true);
    expect(r.checks.find((c) => c.name === "node-version")?.status).toBe("ok");
  });

  it("Phase 6.1: 只有 1 个 check (node-version)", () => {
    const r = runDoctor();
    expect(r.checks).toHaveLength(1);
    expect(r.checks[0]!.name).toBe("node-version");
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
