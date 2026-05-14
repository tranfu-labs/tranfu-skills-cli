import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IndexJson, TfsError } from "../src/types.js";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(
    tmpdir(),
    `list-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  try { rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
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
      files: ["SKILL.md"],
      sha: "abc",
    },
    {
      name: "deploy-pipeline",
      type: "own",
      description: "CI/CD 部署",
      path: "own-skills/deploy-pipeline",
      files: ["SKILL.md"],
      sha: "def",
    },
    {
      name: "karpathy-llm",
      type: "external",
      description: "LLM coding guidelines",
      path: "external-skills/karpathy-llm",
      files: ["SKILL.md"],
      sha: "ghi",
      source_url: "https://github.com/example/karpathy-llm",
    },
  ],
};

function mockFetchIndex(body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

function captureExit() {
  return vi.spyOn(process, "exit").mockImplementation((() => {
    throw new Error("process.exit called");
  }) as never);
}

describe("list — 列远端公司库全部 skill", () => {
  it("默认输出: 全部 skill, 按 type 标注", async () => {
    vi.stubGlobal("fetch", mockFetchIndex(mockIndex));
    const { listCommand } = await import("../src/commands/list.js");
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await listCommand({});

    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("3 skill(s) in tranfu-skills");
    expect(out).toContain("auth-helper");
    expect(out).toContain("deploy-pipeline");
    expect(out).toContain("karpathy-llm");
    expect(out).toContain("own");
    expect(out).toContain("external");
  });

  it("--json 完整 schema (含 source_url for external)", async () => {
    vi.stubGlobal("fetch", mockFetchIndex(mockIndex));
    const { listCommand } = await import("../src/commands/list.js");
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await listCommand({ json: true });

    const parsed = JSON.parse(stdoutSpy.mock.calls.map((c) => c[0]).join(""));
    expect(parsed.total).toBe(3);
    expect(parsed.results).toHaveLength(3);
    const external = parsed.results.find(
      (r: any) => r.name === "karpathy-llm"
    );
    expect(external.source_url).toBe("https://github.com/example/karpathy-llm");
    const own = parsed.results.find((r: any) => r.name === "auth-helper");
    expect(own.source_url).toBeUndefined();  // own skill 不带 source_url
  });

  it("空 index → 'Remote index is empty.'", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetchIndex({ ...mockIndex, skills: [] })
    );
    const { listCommand } = await import("../src/commands/list.js");
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await listCommand({});

    const out = stdoutSpy.mock.calls.map((c) => c[0]).join("");
    expect(out).toContain("Remote index is empty");
  });

  it("fetch 404 → exit 1 index_not_initialized", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        headers: { get: () => null },
        text: () => Promise.resolve(""),
      })
    );
    const { listCommand } = await import("../src/commands/list.js");
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    const exitSpy = captureExit();

    await expect(listCommand({})).rejects.toThrow("process.exit called");
    const parsed = JSON.parse(
      stderrSpy.mock.calls.map((c) => c[0]).join("")
    ) as TfsError;
    expect(parsed.error).toBe("index_not_initialized");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("没有 runtime/scope 选项 — list 跟本地状态完全无关", async () => {
    vi.stubGlobal("fetch", mockFetchIndex(mockIndex));
    const { listCommand } = await import("../src/commands/list.js");
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    // 关键: 不传任何 --runtime / --scope, 也不该报 runtime_required
    await listCommand({});
    // 跑通 = pass
  });
});
