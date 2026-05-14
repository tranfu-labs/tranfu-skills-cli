import { fetchIndex } from "../lib/index-fetch.js";
import { emitError } from "../lib/errors.js";
import { getStaleHint, staleMarkerLine } from "../lib/stale-check.js";
import type { TfsError, SkillEntry } from "../types.js";

/**
 * tfs list: 列远端公司库 index.json 的全部 skill (不分 runtime, 不带 query 过滤).
 * 是 `tfs search` 的 "看全部" 版本.
 *
 * 本地已装查询 → 用 `tfs installed`.
 */
export async function listCommand(opts: { json?: boolean }): Promise<void> {
  let index;
  try {
    index = await fetchIndex();
  } catch (e) {
    return emitError(e as TfsError);
  }

  const skills = index.skills;
  const hint = await getStaleHint();

  if (opts.json) {
    const payload: {
      results: Array<{ name: string; type: string; description: string; path: string; sha: string; source_url?: string }>;
      total: number;
      stale_hint?: { outdated_count: number; names: string[] };
    } = {
      results: skills.map((s: SkillEntry) => ({
        name: s.name,
        type: s.type,
        description: s.description,
        path: s.path,
        sha: s.sha,
        ...(s.source_url ? { source_url: s.source_url } : {}),
      })),
      total: skills.length,
    };
    if (hint) payload.stale_hint = hint;
    process.stdout.write(JSON.stringify(payload) + "\n");
    return;
  }

  if (skills.length === 0) {
    process.stdout.write("Remote index is empty.\n");
    const marker = staleMarkerLine(hint);
    if (marker) process.stdout.write("\n" + marker);
    return;
  }

  // 按 type 分组渲染, 跟 search 输出风格一致
  process.stdout.write(`${skills.length} skill(s) in tranfu-skills:\n`);
  const nameW = Math.max(...skills.map((s) => s.name.length));
  for (const s of skills) {
    const desc = s.description.length > 60
      ? s.description.slice(0, 57) + "..."
      : s.description;
    process.stdout.write(`  ${s.name.padEnd(nameW)}   ${desc}   ${s.type}\n`);
  }
  const marker = staleMarkerLine(hint);
  if (marker) process.stdout.write("\n" + marker);
}
