import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveRuntime, ALL_RUNTIMES, type Runtime } from "../lib/runtime.js";
import { parseScope, resolveTargetPath } from "../lib/paths.js";
import { readStamp } from "../lib/stamp.js";
import { emitError } from "../lib/errors.js";
import { getStaleHint, staleMarkerLine } from "../lib/stale-check.js";
import type { TfsError } from "../types.js";

interface InstalledSkill {
  name: string;
  version: string;
  scope: "user" | "project";
  runtime: Runtime;
  path: string;
  status?: "partial";
}

/**
 * tfs installed: 列本地已装的 tranfu-skills.
 *
 * 默认: 跨 runtime 扫所有探到的 runtime (user 不必传 --runtime).
 * 显式 --runtime → 只扫指定的.
 * 显式 --scope=project → 扫 git-root, 单 runtime 必传 --runtime
 *   (project scope 不跨 runtime, 因为 git-root/.<runtime>/skills 两个目录不一定都有意义).
 */
export async function installedCommand(opts: {
  scope?: string;
  runtime?: string;
  json?: boolean;
}): Promise<void> {
  let scope: ReturnType<typeof parseScope>;
  try {
    scope = parseScope(opts.scope);
  } catch (e) {
    return emitError(e as TfsError);
  }

  // 决定扫哪些 runtime:
  // - 显式 --runtime → 单 runtime
  // - 否则 user scope → 扫所有探到的 (跨 runtime); project scope → 强制需 --runtime (用 resolveRuntime)
  let runtimes: Runtime[];
  try {
    if (opts.runtime !== undefined) {
      runtimes = [resolveRuntime(opts.runtime)];
    } else if (scope === "user") {
      // user scope 无 --runtime: 扫所有探到的 runtime, 探不到也不报错 (列空)
      const { detectAvailableRuntimes } = await import("../lib/runtime.js");
      runtimes = detectAvailableRuntimes();
      if (runtimes.length === 0) {
        // 都没探到 → 退化为 ALL_RUNTIMES, 让 resolveTargetPath 后面给空列表
        runtimes = ALL_RUNTIMES;
      }
    } else {
      // project scope 无 --runtime → 强制走 resolveRuntime (会报 runtime_required 如多个/0 个)
      runtimes = [resolveRuntime(opts.runtime)];
    }
  } catch (e) {
    return emitError(e as TfsError);
  }

  const installed: InstalledSkill[] = [];

  for (const runtime of runtimes) {
    let dir: string;
    try {
      dir = resolveTargetPath({ runtime, scope });
    } catch (e) {
      // project scope 非 git repo → 直接报
      return emitError(e as TfsError);
    }

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue; // 目录不存在 (e.g. 没装过 codex 但探到 ~/.codex/ 不带 skills)
    }

    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const skillDir = join(dir, name);
      try {
        if (!statSync(skillDir).isDirectory()) continue;
      } catch { continue; }

      const stamp = readStamp(join(skillDir, "SKILL.md"));
      if (stamp.status === "absent") continue;

      const version =
        stamp.status === "intact"
          ? stamp.data.installed_version
          : stamp.partial.installed_version ?? "(missing)";

      installed.push({
        name,
        version,
        scope,
        runtime,
        path: skillDir,
        ...(stamp.status === "partial" ? { status: "partial" } : {}),
      });
    }
  }

  const hint = await getStaleHint();

  if (opts.json) {
    const payload: { installed: InstalledSkill[]; stale_hint?: { outdated_count: number; names: string[] } } = {
      installed,
    };
    if (hint) payload.stale_hint = hint;
    process.stdout.write(JSON.stringify(payload) + "\n");
    return;
  }

  if (installed.length === 0) {
    process.stdout.write(
      `No tranfu-skills installed${runtimes.length === 1 ? ` (${runtimes[0]}, ${scope})` : ""}.\n`
    );
    const marker = staleMarkerLine(hint);
    if (marker) process.stdout.write("\n" + marker);
    return;
  }

  process.stdout.write(
    `${installed.length} skill(s) installed:\n`
  );
  const nameW = Math.max(...installed.map((s) => s.name.length));
  for (const s of installed) {
    const shortSha = s.version.slice(0, 7);
    const partialMarker = s.status === "partial" ? " [partial]" : "";
    process.stdout.write(
      `  ${s.name.padEnd(nameW)}  ${shortSha}  ${s.runtime}/${s.scope}${partialMarker}\n`
    );
  }
  const marker = staleMarkerLine(hint);
  if (marker) process.stdout.write("\n" + marker);
}
