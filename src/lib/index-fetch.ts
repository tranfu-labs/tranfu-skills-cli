import { mkdirSync, readFileSync, writeFileSync, statSync } from "fs";
import type { IndexJson } from "../types.js";

const INDEX_URL =
  "https://raw.githubusercontent.com/tranfu-labs/tranfu-skills/main/index.json";
const CACHE_DIR = `${process.env.HOME}/.tfs/cache`;
const CACHE_FILE = `${CACHE_DIR}/index.json`;
const ETAG_FILE = `${CACHE_DIR}/index.etag`;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function ensureCacheDir(): void {
  mkdirSync(CACHE_DIR, { recursive: true });
}

function readCache(): IndexJson | null {
  try {
    const raw = readFileSync(CACHE_FILE, "utf8");
    return JSON.parse(raw) as IndexJson;
  } catch {
    return null;
  }
}

function readEtag(): string | null {
  try {
    return readFileSync(ETAG_FILE, "utf8").trim();
  } catch {
    return null;
  }
}

function cacheAge(): number | null {
  try {
    const stat = statSync(CACHE_FILE);
    return Date.now() - stat.mtimeMs;
  } catch {
    return null;
  }
}

function writeCache(data: IndexJson, etag: string | null): void {
  ensureCacheDir();
  writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), "utf8");
  if (etag) {
    writeFileSync(ETAG_FILE, etag, "utf8");
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
