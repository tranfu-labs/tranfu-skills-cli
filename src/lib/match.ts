import Fuse from "fuse.js";
import type { SkillEntry } from "../types.js";

export function matchSkills(
  query: string,
  all: SkillEntry[],
  top: number
): SkillEntry[] {
  const lower = query.toLowerCase();
  // 1. 子串硬匹配: name 或 description 包含 query (中英文都靠 String.includes)
  const substr = all.filter(
    (s) =>
      s.name.toLowerCase().includes(lower) ||
      s.description.toLowerCase().includes(lower)
  );
  // 2. fuse.js fuzzy 对剩余的排序
  const remaining = all.filter((s) => !substr.includes(s));
  const fuse = new Fuse(remaining, {
    keys: [{ name: "name", weight: 2 }, "description"],
    threshold: 0.6,
    includeScore: true,
  });
  const fuzzy = fuse.search(query).map((r) => r.item);
  return [...substr, ...fuzzy].slice(0, top);
}
