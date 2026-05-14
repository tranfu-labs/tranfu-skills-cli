import { resolveRuntime, type Runtime } from "../lib/runtime.js";
import { parseScope, type Scope } from "../lib/paths.js";
import { readStamp } from "../lib/stamp.js";
import { emitError } from "../lib/errors.js";
import { detectOutdatedCached, staleMarkerLine } from "../lib/stale-check.js";
import { readRegistry } from "../lib/registry.js";
import { join } from "node:path";
import type { TfsError } from "../types.js";

interface InstalledSkill {
  name: string;
  version: string;
  scope: Scope;
  runtime: Runtime;
  path: string;
  outdated: boolean;
  status?: "partial";
}

/**
 * tfs installed: 列本地已装的 tranfu-skills, 跨 (runtime, scope) 默认聚合.
 *
 * 默认 (无 flag): 列 registry 所有 entry, 不再按 CWD 限 project scope.
 * --runtime / --scope: 作为 filter 收窄结果 (零漂移 r1 单 scope 调用).
 */
export async function installedCommand(opts: {
  scope?: string;
  runtime?: string;
  json?: boolean;
}): Promise<void> {
  // filter 解析: 显式时校验, 未传时不限定
  let scopeFilter: Scope | undefined;
  let runtimeFilter: Runtime | undefined;
  try {
    if (opts.scope !== undefined) scopeFilter = parseScope(opts.scope);
    if (opts.runtime !== undefined) runtimeFilter = resolveRuntime(opts.runtime);
  } catch (e) {
    return emitError(e as TfsError);
  }

  // 拉 registry; lazy prune 已在 readRegistry 内部处理.
  const entries = readRegistry().filter((e) => {
    if (scopeFilter && e.scope !== scopeFilter) return false;
    if (runtimeFilter && e.runtime !== runtimeFilter) return false;
    return true;
  });

  // outdated 检测 (silent degrade)
  let outdatedSet = new Set<string>();
  try {
    const detection = await detectOutdatedCached();
    outdatedSet = new Set(
      detection.skills.filter((s) => s.status === "outdated").map((s) => s.name)
    );
  } catch {
    // silent
  }

  const installed: InstalledSkill[] = [];
  for (const e of entries) {
    // 二次读 stamp 以确认 version 当前真值 (registry 可能 stale); 缺戳标 partial
    const stamp = readStamp(join(e.path, "SKILL.md"));
    let version = e.installed_version;
    let stampStatus: "partial" | undefined;
    if (stamp.status === "intact") {
      version = stamp.data.installed_version;
    } else if (stamp.status === "partial") {
      version = stamp.partial.installed_version ?? "(missing)";
      stampStatus = "partial";
    }
    installed.push({
      name: e.name,
      version,
      scope: e.scope,
      runtime: e.runtime,
      path: e.path,
      outdated: outdatedSet.has(e.name),
      ...(stampStatus ? { status: stampStatus } : {}),
    });
  }

  const hint =
    outdatedSet.size > 0
      ? { outdated_count: outdatedSet.size, names: Array.from(outdatedSet).sort() }
      : null;

  if (opts.json) {
    const payload: {
      installed: InstalledSkill[];
      stale_hint?: { outdated_count: number; names: string[] };
    } = { installed };
    if (hint) payload.stale_hint = hint;
    process.stdout.write(JSON.stringify(payload) + "\n");
    return;
  }

  if (installed.length === 0) {
    const filterDesc = [
      runtimeFilter ? `runtime=${runtimeFilter}` : null,
      scopeFilter ? `scope=${scopeFilter}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    process.stdout.write(
      `No tranfu-skills installed${filterDesc ? ` (${filterDesc})` : ""}.\n`
    );
    const marker = staleMarkerLine(hint);
    if (marker) process.stdout.write("\n" + marker);
    return;
  }

  process.stdout.write(`${installed.length} skill(s) installed:\n`);
  const nameW = Math.max(...installed.map((s) => s.name.length));
  for (const s of installed) {
    const shortSha = s.version.slice(0, 7);
    const partialMarker = s.status === "partial" ? " [partial]" : "";
    const outdatedMarker = s.outdated ? " outdated" : "";
    process.stdout.write(
      `  ${s.name.padEnd(nameW)}  ${shortSha}  ${s.runtime}/${s.scope}${partialMarker}${outdatedMarker}\n`
    );
  }
  const marker = staleMarkerLine(hint);
  if (marker) process.stdout.write("\n" + marker);
}
