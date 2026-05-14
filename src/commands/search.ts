import { fetchIndex } from "../lib/index-fetch.js";
import { matchSkills } from "../lib/match.js";
import { renderHuman, renderJson } from "../lib/format.js";
import { emitError } from "../lib/errors.js";
import type { TfsError } from "../types.js";

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
  if (opts.json) {
    process.stdout.write(renderJson(results) + "\n");
  } else {
    process.stdout.write(renderHuman(query, results) + "\n");
  }
}
