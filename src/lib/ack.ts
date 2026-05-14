import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * deleted-upstream ack: 记录用户已经确认"这个 skill 在公司库被删了, 别再 warn 我"
 * 的 skill 列表. 存在 ~/.tfs/cache/ack.json.
 *
 * 路径解析 lazy (函数), 与 index-fetch.ts 一致, 便于测试 mock node:os homedir.
 */

interface AckFile {
  deleted_upstream: string[];
}

function ackPath(): string {
  return join(homedir(), ".tfs", "cache", "ack.json");
}

export function readAck(): Set<string> {
  try {
    const raw = readFileSync(ackPath(), "utf8");
    const parsed = JSON.parse(raw) as AckFile;
    return new Set(parsed.deleted_upstream ?? []);
  } catch {
    return new Set();
  }
}

export function writeAck(deletedUpstream: Set<string>): void {
  const dir = join(homedir(), ".tfs", "cache");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const payload: AckFile = {
    deleted_upstream: Array.from(deletedUpstream).sort(),
  };
  writeFileSync(ackPath(), JSON.stringify(payload, null, 2), "utf8");
}
