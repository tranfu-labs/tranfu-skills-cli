import { mkdirSync, readFileSync, writeFileSync, statSync } from "fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { IndexJson } from "../types.js";

const INDEX_URL =
  "https://github.com/tranfu-labs/tranfu-skills/releases/latest/download/index.json";
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// Lazy resolution: 不在 module-load 时绑定 CACHE_DIR, 否则 vitest mock node:os homedir
// 在 fetchIndex 调用时不会生效 (常量已经绑定真实 homedir). 每次调用走函数读最新 homedir.
function cachePaths(): { dir: string; indexFile: string; etagFile: string } {
  const dir = join(homedir(), ".tfs", "cache");
  return {
    dir,
    indexFile: join(dir, "index.json"),
    etagFile: join(dir, "index.etag"),
  };
}

function ensureCacheDir(): void {
  mkdirSync(cachePaths().dir, { recursive: true });
}

function readCache(): IndexJson | null {
  try {
    const raw = readFileSync(cachePaths().indexFile, "utf8");
    return JSON.parse(raw) as IndexJson;
  } catch {
    return null;
  }
}

function readEtag(): string | null {
  try {
    return readFileSync(cachePaths().etagFile, "utf8").trim();
  } catch {
    return null;
  }
}

function cacheAge(): number | null {
  try {
    const stat = statSync(cachePaths().indexFile);
    return Date.now() - stat.mtimeMs;
  } catch {
    return null;
  }
}

function writeCache(data: IndexJson, etag: string | null): void {
  ensureCacheDir();
  const p = cachePaths();
  writeFileSync(p.indexFile, JSON.stringify(data, null, 2), "utf8");
  if (etag) {
    writeFileSync(p.etagFile, etag, "utf8");
  }
}

export async function fetchIndex(): Promise<IndexJson> {
  // 1. 检查 5min TTL, 命中直接 return cached
  const age = cacheAge();
  if (age !== null && age < CACHE_TTL_MS) {
    const cached = readCache();
    if (cached) return cached;
  }

  // 2. fetch with If-None-Match: <etag>
  const etag = readEtag();
  const headers: Record<string, string> = {};
  if (etag) {
    headers["If-None-Match"] = etag;
  }

  let response: Response;
  try {
    response = await fetch(INDEX_URL, { headers });
  } catch (err) {
    // Network-layer failure (DNS, timeout, etc.)
    const cached = readCache();
    if (cached) {
      // Soft fallback: have cache (any age), warn and return
      process.stderr.write(
        JSON.stringify({
          warning: "network_error",
          message: "网络请求失败, 使用本地缓存 (可能不是最新版)",
          hint: "恢复网络后重新运行 tfs search 以获取最新 index",
        }) + "\n"
      );
      return cached;
    }
    // No cache — hard throw
    throw {
      error: "network_error",
      message: `无法连接 index 服务: ${String(err)}`,
      hint: "检查网络连接, 或联系维护者确认 index 服务状态",
      exit_code: 2,
    };
  }

  // 3. 404 → index_not_initialized
  if (response.status === 404) {
    throw {
      error: "index_not_initialized",
      message: "index.json 不存在 (公司库尚未初始化)",
      hint: "维护者运行: npm run build:index && git push",
      exit_code: 1,
    };
  }

  // 4. 304 → return cached
  if (response.status === 304) {
    const cached = readCache();
    if (cached) return cached;
    // Stale etag with no local file — fall through to re-fetch (shouldn't happen)
  }

  // 5. Other non-2xx (5xx etc.) — network_error
  if (!response.ok) {
    const cached = readCache();
    if (cached) {
      // Soft fallback
      process.stderr.write(
        JSON.stringify({
          warning: "network_error",
          message: `index 服务返回 ${response.status}, 使用本地缓存 (可能不是最新版)`,
          hint: "恢复网络后重新运行 tfs search 以获取最新 index",
        }) + "\n"
      );
      return cached;
    }
    throw {
      error: "network_error",
      message: `index 服务返回 HTTP ${response.status}`,
      hint: "检查网络连接, 或联系维护者确认 index 服务状态",
      exit_code: 2,
    };
  }

  // 6. 200 → parse, write cache + etag, return
  let data: IndexJson;
  try {
    const text = await response.text();
    data = JSON.parse(text) as IndexJson;
  } catch (err) {
    throw {
      error: "internal_error",
      message: `index.json 解析失败: ${String(err)}`,
      hint: "联系维护者重新生成 index.json",
      exit_code: 3,
    };
  }

  const newEtag = response.headers.get("etag");
  writeCache(data, newEtag);
  return data;
}
