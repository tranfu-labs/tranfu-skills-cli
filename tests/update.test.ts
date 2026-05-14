import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { TfsError } from "../src/types.js";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("../src/lib/npm.js");
});

async function loadUpdateWithNpm(npmMock: {
  getGlobalVersion?: (pkg: string) => string | null;
  getRegistryLatest?: (pkg: string) => string | null;
  installGlobalLatest?: (pkg: string) => void;
}) {
  vi.doMock("../src/lib/npm.js", () => ({
    getGlobalVersion: npmMock.getGlobalVersion ?? (() => null),
    getRegistryLatest: npmMock.getRegistryLatest ?? (() => null),
    installGlobalLatest: npmMock.installGlobalLatest ?? (() => undefined),
  }));
  return await import("../src/commands/update.js");
}

function captureExit() {
  return vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
}

describe("update --self (Phase 5.1)", () => {
  it("已是 latest → noop, 不跑 npm install", async () => {
    const installSpy = vi.fn();
    const { updateCommand } = await loadUpdateWithNpm({
      getGlobalVersion: () => "1.0.0",
      getRegistryLatest: () => "1.0.0",
      installGlobalLatest: installSpy,
    });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await updateCommand({ self: true });

    expect(installSpy).not.toHaveBeenCalled();
    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("already latest");
    expect(out).toContain("1.0.0");
  });

  it("有新版 → 跑 npm install + 输出 from → to", async () => {
    const installSpy = vi.fn();
    let postInstallVersion = "0.1.0"; // 模拟升级前
    const { updateCommand } = await loadUpdateWithNpm({
      getGlobalVersion: () => postInstallVersion,
      getRegistryLatest: () => "0.2.0",
      installGlobalLatest: () => {
        installSpy();
        postInstallVersion = "0.2.0"; // 模拟升级后
      },
    });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await updateCommand({ self: true });

    expect(installSpy).toHaveBeenCalledOnce();
    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("updated");
    expect(out).toContain("0.1.0");
    expect(out).toContain("0.2.0");
  });

  it("--json 输出 schema (升级路径)", async () => {
    let v = "0.1.0";
    const { updateCommand } = await loadUpdateWithNpm({
      getGlobalVersion: () => v,
      getRegistryLatest: () => "0.2.0",
      installGlobalLatest: () => { v = "0.2.0"; },
    });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await updateCommand({ self: true, json: true });

    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""));
    expect(parsed).toMatchObject({
      self: { from: "0.1.0", to: "0.2.0" },
      skills: [],
    });
  });

  it("--json noop 路径 含 status:'noop'", async () => {
    const { updateCommand } = await loadUpdateWithNpm({
      getGlobalVersion: () => "0.1.0",
      getRegistryLatest: () => "0.1.0",
    });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await updateCommand({ self: true, json: true });

    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""));
    expect(parsed.self).toEqual({ from: "0.1.0", to: "0.1.0", status: "noop" });
  });

  it("installGlobalLatest 抛错 → internal_error exit 3", async () => {
    const { updateCommand } = await loadUpdateWithNpm({
      getGlobalVersion: () => "0.1.0",
      getRegistryLatest: () => "0.2.0",
      installGlobalLatest: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const exitSpy = captureExit();

    await expect(updateCommand({ self: true })).rejects.toThrow(
      "process.exit called"
    );

    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("internal_error");
    expect(parsed.message).toContain("EACCES");
    expect(parsed.hint).toContain("npm install -g");
    expect(exitSpy).toHaveBeenCalledWith(3);
  });

  it("默认 (无 --self 也无 --skills-only) → 走 --self 行为", async () => {
    const { updateCommand } = await loadUpdateWithNpm({
      getGlobalVersion: () => "1.0.0",
      getRegistryLatest: () => "1.0.0",
    });
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await updateCommand({});

    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("already latest");
  });
});

describe("update --skills-only (Phase 5.2 未实现)", () => {
  it("--skills-only → not_implemented exit 1", async () => {
    const { updateCommand } = await loadUpdateWithNpm({});
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    captureExit();

    await expect(updateCommand({ skillsOnly: true })).rejects.toThrow(
      "process.exit called"
    );

    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("not_implemented");
    expect(parsed.message).toContain("5.2");
  });
});
