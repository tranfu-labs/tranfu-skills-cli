import { execSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";

/**
 * Hermes profile 名合法字符集. 与 ~/.hermes/profiles/<name>/ 目录名做正则过滤,
 * 也用于校验 --scope profile:<name>. 用宽松字母数字+下划线+连字符防 `../` 注入.
 */
export const PROFILE_NAME_RE = /^[a-zA-Z0-9_-]+$/;

/** Hermes 命名 profile 根目录 (默认 profile 不在此, 在 ~/.hermes 本身) */
function profilesDir(): string {
  return join(homedir(), ".hermes", "profiles");
}

/**
 * 列出 ~/.hermes/profiles/ 下所有命名 profile.
 * 过滤: 不以 . 开头 + 是目录 + 名字匹配 PROFILE_NAME_RE.
 * profiles 目录不存在 / 读不到 → []
 */
export function listHermesProfiles(): string[] {
  let names: string[];
  try {
    names = readdirSync(profilesDir());
  } catch {
    return [];
  }
  return names.filter((n) => {
    if (n.startsWith(".")) return false;
    if (!PROFILE_NAME_RE.test(n)) return false;
    try {
      return statSync(join(profilesDir(), n)).isDirectory();
    } catch {
      return false;
    }
  });
}

/**
 * 探测当前 active 的 hermes profile.
 * 三段 fallback (优先级从高到低):
 *  1. 读 $HERMES_HOME, 若匹配 ~/.hermes/profiles/<name> 前缀 → 返 <name>
 *     (env 指向 ~/.hermes 本身 / 不可识别 → 进 2)
 *  2. exec `hermes profile list`, 找带 (active) 或开头 * 的行 → 返其 profile 名
 *     (命令不存在 / 非零退出 / 输出格式不匹配 → 进 3)
 *  3. 返 null = 默认 profile (调用方等价 scope=user, 装到 ~/.hermes/skills/tranfu/)
 *
 * 任何阶段抛错 MUST 被吞掉 (install 等主流程不能因此崩).
 */
export function detectActiveProfile(): string | null {
  // (1) env var
  const env = process.env.HERMES_HOME;
  if (env) {
    const root = profilesDir() + sep;
    if (env.startsWith(root)) {
      const tail = env.slice(root.length).split(sep)[0];
      if (tail && PROFILE_NAME_RE.test(tail)) return tail;
    }
    // env 指向 ~/.hermes 本身, 或别的不可识别路径 → 落到下一段
  }

  // (2) exec hermes profile list
  try {
    const out = execSync("hermes profile list", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    // 兼容两种常见格式:
    //   "coder (active)"  /  "* coder"  /  "> coder"
    const m =
      out.match(/^[\s*>]*([a-zA-Z0-9_-]+)\s+\(active\)/m) ??
      out.match(/^\*\s+([a-zA-Z0-9_-]+)/m) ??
      out.match(/^>\s+([a-zA-Z0-9_-]+)/m);
    if (m && m[1] && PROFILE_NAME_RE.test(m[1])) return m[1];
  } catch {
    // hermes 不在 PATH / 返非零 / 解析失败 — silent
  }

  // (3) fallback null
  return null;
}
