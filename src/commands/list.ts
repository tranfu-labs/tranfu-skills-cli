import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveRuntime } from "../lib/runtime.js";
import { parseScope, resolveTargetPath } from "../lib/paths.js";
import { readStamp } from "../lib/stamp.js";
import { emitError } from "../lib/errors.js";
import type { TfsError } from "../types.js";

interface ListedSkill {
  name: string;
  version: string;       // installed_version (full sha)
  scope: "user" | "project";
  runtime: "claude-code" | "codex";
  path: string;
  status: "intact" | "partial";
}

export async function listCommand(opts: {
  scope?: string;
  runtime?: string;
  json?: boolean;
}) {
  let runtime: ReturnType<typeof resolveRuntime>;
  let scope: ReturnType<typeof parseScope>;
  let dir: string;
  try {
    runtime = resolveRuntime(opts.runtime);
    scope = parseScope(opts.scope);
    dir = resolveTargetPath({ runtime, scope });
  } catch (e) {
    return emitError(e as TfsError);
  }

  // 扫目录, 收集所有有 tranfu-skills 戳的子目录
  const installed: ListedSkill[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // dir 不存在或不可读 — 视为"未装过", 返回空列表
    entries = [];
  }

  for (const name of entries) {
    if (name.startsWith(".")) continue; // 跳过 .tfs-staging / 其他 dotfile
    const skillDir = join(dir, name);
    let st;
    try {
      st = statSync(skillDir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;

    const skillMd = join(skillDir, "SKILL.md");
    const stamp = readStamp(skillMd);
    if (stamp.status === "absent") continue; // 非 tranfu-skills 装的 skip

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
      status: stamp.status,
    });
  }

  // 输出
  if (opts.json) {
    process.stdout.write(
      JSON.stringify({
        installed: installed.map((s) => ({
          name: s.name,
          version: s.version,
          scope: s.scope,
          runtime: s.runtime,
          path: s.path,
          ...(s.status === "partial" ? { status: "partial" } : {}),
        })),
      }) + "\n"
    );
    return;
  }

  if (installed.length === 0) {
    process.stdout.write(
      `No tranfu-skills installed in ${dir}.\n`
    );
    return;
  }

  process.stdout.write(
    `${installed.length} skill(s) installed (${runtime}, ${scope}):\n`
  );
  const nameW = Math.max(...installed.map((s) => s.name.length));
  for (const s of installed) {
    const shortSha = s.version.slice(0, 7);
    const marker = s.status === "partial" ? " [partial]" : "";
    process.stdout.write(`  ${s.name.padEnd(nameW)}  ${shortSha}${marker}\n`);
  }
}
