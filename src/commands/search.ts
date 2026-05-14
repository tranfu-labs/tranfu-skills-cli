import { fetchIndex } from "../lib/index-fetch.js";
import { matchSkills } from "../lib/match.js";
import { renderHuman } from "../lib/format.js";
import { emitError } from "../lib/errors.js";
import { detectOutdatedCached, staleMarkerLine } from "../lib/stale-check.js";
import type { TfsError, SkillEntry } from "../types.js";

interface SearchResult {
  name: string;
  type: SkillEntry["type"];
  description: string;
  path: string;
  sha: string;
  installed: boolean;
  outdated: boolean | null; // null = 未装因此无法判断
}

export async function searchCommand(
  query: string,
  opts: { top: string; json?: boolean }
) {
  const top = parseInt(opts.top, 10);
  if (isNaN(top) || top < 1 || top > 50) {
    return emitError({
      error: "top_n_invalid",
      message: `--top N 必须在 1-50 之间, 当前: ${opts.top}`,
      hint: "默认 5, 上限 50",
      exit_code: 1,
    });
  }

  let index;
  try {
    index = await fetchIndex();
  } catch (e) {
    return emitError(e as TfsError); // index_not_initialized | network_error
  }

  // slice-4: cross-ref 本机已装. 复用 slice-2 cache wrapper (silent on fail).
  let installedSet = new Set<string>();
  let outdatedSet = new Set<string>();
  try {
    const detection = await detectOutdatedCached();
    for (const s of detection.skills) {
      installedSet.add(s.name);
      if (s.status === "outdated") outdatedSet.add(s.name);
    }
  } catch {
    // silent degrade — search 主功能不依赖 detection
  }

  const matched = matchSkills(query, index.skills, top);
  const results: SearchResult[] = matched.map((s) => {
    const installed = installedSet.has(s.name);
    return {
      name: s.name,
      type: s.type,
      description: s.description,
      path: s.path,
      sha: s.sha,
      installed,
      outdated: installed ? outdatedSet.has(s.name) : null,
    };
  });

  const hint =
    outdatedSet.size > 0
      ? {
          outdated_count: outdatedSet.size,
          names: Array.from(outdatedSet).sort(),
        }
      : null;

  if (opts.json) {
    const payload: {
      results: SearchResult[];
      total: number;
      stale_hint?: { outdated_count: number; names: string[] };
    } = {
      results,
      total: results.length,
    };
    if (hint) payload.stale_hint = hint;
    process.stdout.write(JSON.stringify(payload) + "\n");
  } else {
    // text 模式: renderHuman 给的是 results 列表, 我们 post-hoc 在每行追 [installed]/[installed, outdated].
    // 简单: 自己 render, 不复用 renderHuman, 避免分裂.
    process.stdout.write(renderSearchText(query, results) + "\n");
    const marker = staleMarkerLine(hint);
    if (marker) process.stdout.write("\n" + marker);
  }
}

function renderSearchText(query: string, results: SearchResult[]): string {
  if (results.length === 0) return `没找到 "${query}" 相关的 skill.`;
  const lines = [`${results.length} results for "${query}":`];
  const nameW = Math.max(...results.map((r) => r.name.length));
  for (const s of results) {
    const tag = s.installed
      ? s.outdated
        ? " [installed, outdated]"
        : " [installed]"
      : "";
    lines.push(
      `  ${s.name.padEnd(nameW)}   ${s.description.slice(0, 60)}   ${s.type}${tag}`
    );
  }
  return lines.join("\n");
}
