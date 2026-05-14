import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpHome: string;

beforeEach(() => {
  tmpHome = join(
    tmpdir(),
    `ack-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
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

describe("ack.ts", () => {
  it("readAck: ack.json 不存在 → 空 Set", async () => {
    const { readAck } = await import("../src/lib/ack.js");
    const acks = readAck();
    expect(acks.size).toBe(0);
  });

  it("readAck: ack.json 存在 → 解析 deleted_upstream", async () => {
    mkdirSync(join(tmpHome, ".tfs", "cache"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".tfs", "cache", "ack.json"),
      JSON.stringify({ deleted_upstream: ["foo", "bar"] })
    );
    const { readAck } = await import("../src/lib/ack.js");
    const acks = readAck();
    expect(acks.size).toBe(2);
    expect(acks.has("foo")).toBe(true);
    expect(acks.has("bar")).toBe(true);
  });

  it("readAck: 文件存在但 JSON 损坏 → 空 Set (不崩)", async () => {
    mkdirSync(join(tmpHome, ".tfs", "cache"), { recursive: true });
    writeFileSync(
      join(tmpHome, ".tfs", "cache", "ack.json"),
      "{ not valid json"
    );
    const { readAck } = await import("../src/lib/ack.js");
    expect(readAck().size).toBe(0);
  });

  it("writeAck: 写入文件, name 排序", async () => {
    const { writeAck } = await import("../src/lib/ack.js");
    writeAck(new Set(["foo", "bar", "baz"]));
    const ackPath = join(tmpHome, ".tfs", "cache", "ack.json");
    expect(existsSync(ackPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(ackPath, "utf8"));
    expect(parsed.deleted_upstream).toEqual(["bar", "baz", "foo"]); // 排序
  });

  it("writeAck → readAck 往返一致", async () => {
    const { readAck, writeAck } = await import("../src/lib/ack.js");
    writeAck(new Set(["alpha", "beta"]));
    const acks = readAck();
    expect(acks.has("alpha")).toBe(true);
    expect(acks.has("beta")).toBe(true);
  });

  it("writeAck 创建 cache dir 如不存在", async () => {
    const { writeAck } = await import("../src/lib/ack.js");
    expect(existsSync(join(tmpHome, ".tfs", "cache"))).toBe(false);
    writeAck(new Set(["foo"]));
    expect(existsSync(join(tmpHome, ".tfs", "cache"))).toBe(true);
  });
});
