import { readFileSync, writeFileSync } from "node:fs";

export type StampSource = "own" | "external" | "meta";

export interface StampData {
  installed_by: "tranfu-skills";
  installed_version: string;  // index.json 里的 sha
  installed_at: string;       // ISO date "2026-05-14"
  installed_source: StampSource;
}

/**
 * 戳三态 (对齐 V3 变更 4 / install 流程判断树):
 * - intact:  4 个字段都齐, install 后 sha 对比走 noop / update
 * - partial: 有 installed_by 但其他字段缺/无效 → 视为损坏戳, install 时报 skill_already_installed 走 --force
 * - absent:  没有 installed_by 字段, 视为用户手装或第三方 skill, install 时报 skill_already_installed 需 --force
 */
export type StampStatus =
  | { status: "intact"; data: StampData }
  | { status: "partial"; partial: Partial<StampData> }
  | { status: "absent" };

const STAMP_KEYS = [
  "installed_by",
  "installed_version",
  "installed_at",
  "installed_source",
] as const;

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---/;

/** 简单 key: value frontmatter 解析 (戳字段都是单行简单值, 不需 block scalar) */
function parseFrontmatterSimple(md: string): Record<string, string> {
  const m = md.match(FRONTMATTER_RE);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const kv = line.match(/^(\w+):\s*(.*)$/);
    if (kv) out[kv[1]!] = kv[2]!.trim();
  }
  return out;
}

export function parseStamp(md: string): StampStatus {
  const fm = parseFrontmatterSimple(md);
  if (fm.installed_by !== "tranfu-skills") {
    return { status: "absent" };
  }
  const partial: Partial<StampData> = { installed_by: "tranfu-skills" };
  let complete = true;

  if (fm.installed_version) partial.installed_version = fm.installed_version;
  else complete = false;

  if (fm.installed_at) partial.installed_at = fm.installed_at;
  else complete = false;

  if (
    fm.installed_source === "own" ||
    fm.installed_source === "external" ||
    fm.installed_source === "meta"
  ) {
    partial.installed_source = fm.installed_source;
  } else {
    complete = false;  // 缺失或非法值都视为 partial
  }

  if (complete) {
    return { status: "intact", data: partial as StampData };
  }
  return { status: "partial", partial };
}

/** 读 SKILL.md, 返回戳状态; 文件不存在视为 absent */
export function readStamp(skillMdPath: string): StampStatus {
  try {
    const md = readFileSync(skillMdPath, "utf8");
    return parseStamp(md);
  } catch {
    return { status: "absent" };
  }
}

/**
 * 写戳到 SKILL.md 的 frontmatter.
 * - 已有 frontmatter: 移除旧 installed_* 行, 追加新 stamp 字段
 * - 无 frontmatter: 新建一个 frontmatter 块, 放在文件最前
 * - 非戳字段 (name/description/含 block scalar 等) 一律保留
 */
export function writeStamp(skillMdPath: string, stamp: StampData): void {
  let md: string;
  try {
    md = readFileSync(skillMdPath, "utf8");
  } catch {
    md = "";
  }

  const stampLines = STAMP_KEYS.map((k) => `${k}: ${stamp[k]}`);

  const m = md.match(FRONTMATTER_RE);
  if (m) {
    // 移除原有 stamp keys 行 (只看顶级 key 行, 不动缩进延续行如 block scalar 续行)
    const cleaned = m[1]!
      .split("\n")
      .filter((line) => {
        const kv = line.match(/^(\w+):/);
        if (!kv) return true;
        return !(STAMP_KEYS as readonly string[]).includes(kv[1]!);
      });
    const newFmBody = [...cleaned, ...stampLines].join("\n");
    md = md.replace(FRONTMATTER_RE, `---\n${newFmBody}\n---`);
  } else {
    md = `---\n${stampLines.join("\n")}\n---\n${md}`;
  }
  writeFileSync(skillMdPath, md, "utf8");
}
