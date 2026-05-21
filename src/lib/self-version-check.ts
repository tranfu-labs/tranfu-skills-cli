import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { confirm, isInteractive } from "./prompt.js";

const REGISTRY_URL = "https://registry.npmjs.org/tranfu-skills/latest";
const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DECLINE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h
const CACHE_FILE = "last-self-check.json";

export interface SelfCheckCache {
  checked_at: string;
  latest: string;
  /** ISO 时间. now < declined_until → TTY prompt 跳过 (stderr nag 不受影响). */
  declined_until?: string;
}

function cachePath(): string {
  return join(homedir(), ".tfs", "cache", CACHE_FILE);
}

function readCache(): SelfCheckCache | null {
  try {
    const raw = readFileSync(cachePath(), "utf8");
    return JSON.parse(raw) as SelfCheckCache;
  } catch {
    return null;
  }
}

function writeCache(payload: SelfCheckCache): void {
  try {
    const dir = join(homedir(), ".tfs", "cache");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(payload, null, 2), "utf8");
  } catch {
    // silent
  }
}

function isCacheFresh(cache: SelfCheckCache, now: Date): boolean {
  try {
    const checked = new Date(cache.checked_at);
    if (Number.isNaN(checked.getTime())) return false;
    const age = now.getTime() - checked.getTime();
    return age >= 0 && age < CACHE_TTL_MS;
  } catch {
    return false;
  }
}

/** semver-ish compare without dep: split('.').map(Number) lex. 返回 a<b → -1, a==b → 0, a>b → 1. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number(x) || 0);
  const pb = b.split(".").map((x) => Number(x) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

function readCurrentVersion(): string | null {
  try {
    // src/lib/self-version-check.ts → ../../package.json (运行时 dist/cli.js → ../package.json)
    // 试两个候选路径.
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "..", "..", "package.json"),
      join(here, "..", "package.json"),
    ];
    for (const p of candidates) {
      try {
        const raw = readFileSync(p, "utf8");
        const pkg = JSON.parse(raw) as { version?: string; name?: string };
        if (pkg.name === "tranfu-skills" && typeof pkg.version === "string") {
          return pkg.version;
        }
      } catch {
        // try next
      }
    }
  } catch {
    // silent
  }
  return null;
}

async function fetchLatestVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(REGISTRY_URL, { signal: controller.signal });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    if (typeof data.version === "string") return data.version;
    return null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * fire-and-forget 自检: 调 npm registry 比对版本, 落后则 stderr 一行提示.
 * 任何失败 silent return, 绝不 throw — 不能阻塞 CLI 主流程.
 *
 * skip 条件:
 *  - process.env.NODE_ENV === 'test' / process.env.VITEST (测试环境)
 *  - process.env.TFS_NO_NAG === '1'
 *  - process.argv 含 '--json' (JSON consumer)
 *  - 24h cache 命中
 */
export async function checkSelfVersion(): Promise<void> {
  try {
    if (process.env.NODE_ENV === "test") return;
    if (process.env.VITEST) return;
    if (process.env.TFS_NO_NAG === "1") return;
    if (process.argv.includes("--json")) return;

    const current = readCurrentVersion();
    if (!current) return;

    const now = new Date();
    const cache = readCache();
    if (cache && isCacheFresh(cache, now)) {
      // cache 内有 latest, 直接比对 — 不打 registry
      if (compareVersions(cache.latest, current) > 0) {
        process.stderr.write(
          `tranfu-skills ${cache.latest} 已发布 (当前 ${current}). 跑 \`tfs update --self\` 升级.\n`
        );
      }
      return;
    }

    const latest = await fetchLatestVersion();
    if (!latest) return;

    writeCache({
      checked_at: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
      latest,
    });

    if (compareVersions(latest, current) > 0) {
      process.stderr.write(
        `tranfu-skills ${latest} 已发布 (当前 ${current}). 跑 \`tfs update --self\` 升级.\n`
      );
    }
  } catch {
    // silent — hard rule
  }
}

/**
 * sync 决策: 是否应该弹 TTY 升级 prompt.
 * 只读 cache, 不发起网络. 所有 skip 条件都在这里集中判.
 *
 * 返回 { latest, current } → 应该 prompt; null → 别 prompt (走 fire-and-forget refresh).
 */
export function shouldPromptInteractiveUpgrade(): {
  latest: string;
  current: string;
} | null {
  if (process.env.NODE_ENV === "test") return null;
  if (process.env.VITEST) return null;
  if (process.env.TFS_NO_NAG === "1") return null;
  if (process.argv.includes("--json")) return null;
  if (!isInteractive()) return null;

  const cache = readCache();
  if (!cache) return null;

  const now = new Date();
  if (!isCacheFresh(cache, now)) return null;

  if (cache.declined_until) {
    const decl = new Date(cache.declined_until);
    if (!Number.isNaN(decl.getTime()) && now < decl) return null;
  }

  const current = readCurrentVersion();
  if (!current) return null;

  if (compareVersions(cache.latest, current) <= 0) return null;
  return { latest: cache.latest, current };
}

/**
 * 入口: 在 TTY + cache 显示 outdated + 未 declined 时弹 interactive prompt.
 * 否则 fire-and-forget refresh + stderr nag (原 checkSelfVersion 行为).
 *
 * - Y → execSync `npm install -g tranfu-skills@latest` + 提示重跑 + process.exit(0).
 *   (binary 已被替换, 但当前 Node 进程内存里仍是旧代码, 必须重跑.)
 * - N → 写 declined_until = now + 24h, 继续跑原命令.
 * - 升级失败 → stderr 报错 + 继续跑原命令 (老版本仍能用).
 *
 * 任何异常 → silent 吞掉, 不阻塞主流程.
 */
export async function maybePromptSelfUpgrade(): Promise<void> {
  try {
    const should = shouldPromptInteractiveUpgrade();
    if (!should) {
      // cache miss / stale / 非 TTY / json / declined / 不 outdated → 后台 refresh + 原 stderr nag
      void checkSelfVersion();
      return;
    }

    const ok = await confirm(
      `tranfu-skills ${should.latest} 已发布 (当前 ${should.current}). 现在升级?`
    );

    if (ok) {
      process.stderr.write("升级中: npm install -g tranfu-skills@latest\n");
      try {
        execSync("npm install -g tranfu-skills@latest", { stdio: "inherit" });
        const rerun = process.argv.slice(2).join(" ");
        process.stderr.write(
          `\n✓ 升级完成. 请重跑: tfs ${rerun || "<your command>"}\n`
        );
        process.exit(0);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `升级失败 (${msg}). 手动跑: npm install -g tranfu-skills@latest\n`
        );
        // 不 exit — 老版本仍可用, 继续跑原命令
        return;
      }
    } else {
      // declined: 24h 内不再 prompt
      try {
        const cache = readCache();
        if (cache) {
          const declinedUntil = new Date(Date.now() + DECLINE_WINDOW_MS);
          writeCache({
            ...cache,
            declined_until: declinedUntil
              .toISOString()
              .replace(/\.\d{3}Z$/, "Z"),
          });
        }
      } catch {
        // silent
      }
      return;
    }
  } catch {
    // hard rule: 任何 throw 都不能阻塞主流程
  }
}
