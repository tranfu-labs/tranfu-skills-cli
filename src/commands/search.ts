import { fetchIndex } from "../lib/index-fetch.js";
import { matchSkills } from "../lib/match.js";
import { renderHuman } from "../lib/format.js";
import { emitError } from "../lib/errors.js";
import { getStaleHint, staleMarkerLine } from "../lib/stale-check.js";
import type { TfsError, SkillEntry } from "../types.js";

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

  const results = matchSkills(query, index.skills, top);
  const hint = await getStaleHint();

  if (opts.json) {
    const payload: {
      results: Array<Pick<SkillEntry, "name" | "type" | "description" | "path" | "sha">>;
      total: number;
      stale_hint?: { outdated_count: number; names: string[] };
    } = {
      results: results.map((s) => ({
        name: s.name,
        type: s.type,
        description: s.description,
        path: s.path,
        sha: s.sha,
      })),
      total: results.length,
    };
    if (hint) payload.stale_hint = hint;
    process.stdout.write(JSON.stringify(payload) + "\n");
  } else {
    process.stdout.write(renderHuman(query, results) + "\n");
    const marker = staleMarkerLine(hint);
    if (marker) process.stdout.write("\n" + marker);
  }
}
