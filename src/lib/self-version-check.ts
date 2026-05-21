import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REGISTRY_URL = "https://registry.npmjs.org/tranfu-skills/latest";
const FETCH_TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const CACHE_FILE = "last-self-check.json";

interface SelfCheckCache {
  checked_at: string;
  latest: string;
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
