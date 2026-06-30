import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SkillUpdateResult } from "../types.js";
import { fetchIndex } from "./index-fetch.js";
import { ALL_RUNTIMES, type Runtime } from "./runtime.js";
import { resolveTargetPath, SCOPE_USER, type Scope } from "./paths.js";
import { listHermesProfiles } from "./hermes.js";
import { readStamp } from "./stamp.js";
import { readAck } from "./ack.js";

const TTL_HOURS = 6;
const CACHE_FILE = "last-check.json";

interface CacheFile {
  checked_at: string;
  ttl_hours: number;
  skills: SkillUpdateResult[];
}

function cachePath(): string {
  return join(homedir(), ".tfs", "cache", CACHE_FILE);
}

function readCache(): CacheFile | null {
  try {
    const raw = readFileSync(cachePath(), "utf8");
    return JSON.parse(raw) as CacheFile;
  } catch {
    return null;
  }
}

function writeCache(payload: CacheFile): void {
  const dir = join(homedir(), ".tfs", "cache");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(cachePath(), JSON.stringify(payload, null, 2), "utf8");
}

function isCacheFresh(cache: CacheFile, now: Date): boolean {
  const checkedAt = new Date(cache.checked_at);
  if (Number.isNaN(checkedAt.getTime())) return false;
  const ageMs = now.getTime() - checkedAt.getTime();
  const ttlMs = (cache.ttl_hours ?? TTL_HOURS) * 60 * 60 * 1000;
  return ageMs >= 0 && ageMs < ttlMs;
}

export interface DetectOutdatedResult {
  skills: SkillUpdateResult[];
  checked_at: string;
  cached: boolean;
}

/** 构造所有要扫描的 (runtime, scope) 对. claude-code/codex 仅 user; hermes 默认 + 所有命名 profile. */
function scanPairs(): Array<{ runtime: Runtime; scope: Scope }> {
  const pairs: Array<{ runtime: Runtime; scope: Scope }> = [];
  for (const runtime of ALL_RUNTIMES) {
    if (runtime === "hermes") {
      pairs.push({ runtime, scope: SCOPE_USER });
      for (const name of listHermesProfiles()) {
        pairs.push({ runtime, scope: { kind: "profile", name } });
      }
    } else {
      pairs.push({ runtime, scope: SCOPE_USER });
    }
  }
  return pairs;
}

/**
 * 扫所有 runtime 已装 tfs skill 与远端 index sha 比对.
 * claude-code/codex 仅扫 user scope; hermes 同时扫默认 profile 与 listHermesProfiles 列出的所有命名 profile.
 * 返回 stamped skill 的检测结果 (含 noop / outdated / deleted-upstream 全部状态), 每条带 runtime+scope.
 * 不写 cache 文件; 网络挂 throws TfsError 由调用方 handle.
 */
export async function detectOutdated(): Promise<DetectOutdatedResult> {
  const index = await fetchIndex();
  const ackedDeletions = readAck();
  const skills: SkillUpdateResult[] = [];

  for (const { runtime, scope } of scanPairs()) {
    let dir: string;
    try {
      dir = resolveTargetPath({ runtime, scope });
    } catch {
      continue;
    }

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const skillDir = join(dir, name);
      try {
        if (!statSync(skillDir).isDirectory()) continue;
      } catch {
        continue;
      }

      const stamp = readStamp(join(skillDir, "SKILL.md"));
      if (stamp.status === "absent") continue;

      const installedVersion =
        stamp.status === "intact"
          ? stamp.data.installed_version
          : stamp.partial.installed_version ?? "";

      const indexEntry = index.skills.find((s) => s.name === name);
      if (!indexEntry) {
        skills.push({
          name,
          from: installedVersion,
          to: installedVersion,
          status: ackedDeletions.has(name)
            ? "deleted-upstream-acked"
            : "deleted-upstream",
          runtime,
          scope,
        });
        continue;
      }

      if (indexEntry.sha === installedVersion) {
        skills.push({
          name,
          from: installedVersion,
          to: installedVersion,
          status: "noop",
          runtime,
          scope,
        });
        continue;
      }

      skills.push({
        name,
        from: installedVersion,
        to: indexEntry.sha,
        status: "outdated",
        runtime,
        scope,
      });
    }
  }

  return {
    skills,
    checked_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    cached: false,
  };
}

export interface StaleHint {
  outdated_count: number;
  names: string[];
}

/**
 * piggyback 用: 返回 outdated count + names (filter status==='outdated' 仅).
 * 内部走 detectOutdatedCached, silent degrade — 任何错误返 null.
 * 0 outdated → null (调用方据此决定 marker 是否输出).
 */
export async function getStaleHint(): Promise<StaleHint | null> {
  try {
    const { skills } = await detectOutdatedCached();
    const outdated = skills.filter((s) => s.status === "outdated");
    if (outdated.length === 0) return null;
    return {
      outdated_count: outdated.length,
      names: outdated.map((s) => s.name),
    };
  } catch {
    return null;
  }
}

/**
 * 文本模式 piggyback marker 行字面量. 0 outdated 返空串.
 * 行尾带 \n. prefix 永远 `⚠ ` (DoD-010 锁).
 */
export function staleMarkerLine(hint: StaleHint | null): string {
  if (!hint) return "";
  return `⚠ ${hint.outdated_count} 个 skill 可更新\n`;
}

/**
 * piggyback 路径用: 优先读 ~/.tfs/cache/last-check.json (6h TTL),
 * cache 过期/缺失/损坏 → 调 detectOutdated 重测, 写 cache, silent degrade.
 * 网络挂时不抛 — 返回 stale cache (若有) 或空 skills (无 cache 时), 保证主命令不崩.
 */
export async function detectOutdatedCached(): Promise<DetectOutdatedResult> {
  const cache = readCache();
  const now = new Date();
  if (cache && isCacheFresh(cache, now)) {
    return {
      skills: cache.skills,
      checked_at: cache.checked_at,
      cached: true,
    };
  }
  try {
    const fresh = await detectOutdated();
    writeCache({
      checked_at: fresh.checked_at,
      ttl_hours: TTL_HOURS,
      skills: fresh.skills,
    });
    return fresh;
  } catch {
    // silent degrade: 网络 / 解析 / 任何错误 — 主命令不该崩.
    // 有 stale cache 用 stale (cached=true 表示来自 cache); 无 cache 返空.
    if (cache) {
      return {
        skills: cache.skills,
        checked_at: cache.checked_at,
        cached: true,
      };
    }
    return {
      skills: [],
      checked_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
      cached: false,
    };
  }
}
