import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveRuntime, type Runtime } from "../lib/runtime.js";
import {
  parseScope,
  resolveTargetPath,
  scopeToString,
  type Scope,
} from "../lib/paths.js";
import { readStamp } from "../lib/stamp.js";
import { emitError } from "../lib/errors.js";
import { findByName, removeEntryByPath, type RegistryEntry } from "../lib/registry.js";
import type { TfsError } from "../types.js";

interface RemovalTarget {
  path: string;
  runtime: Runtime;
  scope: Scope;
}

function removeOne(t: RemovalTarget): void {
  rmSync(t.path, { recursive: true, force: true });
  removeEntryByPath(t.path);
}

export async function uninstallCommand(
  skillName: string,
  opts: { scope?: string; runtime?: string }
): Promise<void> {
  // 路径 A: 显式 --runtime 或 --scope → 走 r1 单 (runtime, scope) 行为, 零漂移
  if (opts.runtime !== undefined || opts.scope !== undefined) {
    return uninstallSingleScope(skillName, opts);
  }

  // 路径 B: 无 flag → 从 registry 查所有 entry
  const entries = findByName(skillName);
  if (entries.length === 0) {
    return emitError({
      error: "skill_not_found",
      message: `没找到名为 "${skillName}" 的已装 skill (registry 无匹配)`,
      hint: "跑 tfs installed 看已装的 skill",
      exit_code: 1,
    });
  }

  // 1 处 — TTY 确认 / 非 TTY 直删 (零漂移 r1 显式 flag 路径)
  if (entries.length === 1) {
    const e = entries[0]!;
    if (process.stdout.isTTY) {
      const { confirm } = await import("../lib/prompt.js");
      const ok = await confirm(
        `uninstall ${skillName} from ${e.path}  (${e.runtime}, ${scopeToString(e.scope)})?`
      );
      if (!ok) {
        process.stdout.write("cancelled.\n");
        return;
      }
    }
    removeOne(e);
    process.stdout.write(`✓ uninstalled ${skillName} from ${e.path}\n`);
    return;
  }

  // 多处装了同名 skill — TTY 让用户多选 + 确认, 非 TTY 报 ambiguous_target
  if (!process.stdout.isTTY) {
    const locations = entries
      .map(
        (e, i) =>
          `  ${i + 1}. ${e.path}  (${e.runtime}, ${scopeToString(e.scope)})`
      )
      .join("\n");
    return emitError({
      error: "ambiguous_target",
      message: `${skillName} 装在 ${entries.length} 处:\n${locations}`,
      hint: "传 --runtime=claude-code|codex|hermes 与 --scope=user|project|profile:<name> 精确指定, 或在 TTY 终端跑此命令以交互选择",
      exit_code: 1,
    });
  }

  return promptAndRemove(skillName, entries);
}

async function promptAndRemove(
  skillName: string,
  entries: RegistryEntry[]
): Promise<void> {
  const { multiSelectFromList, confirm } = await import("../lib/prompt.js");
  const choices = entries.map(
    (e) => `${e.path}  (${e.runtime}, ${scopeToString(e.scope)})`
  );
  const picked = await multiSelectFromList({
    question: `${skillName} 装在 ${entries.length} 处, 选要卸的:`,
    choices,
  });
  if (picked === "quit") {
    process.stdout.write("cancelled.\n");
    return;
  }
  const targets = picked.map((i) => entries[i]!);

  process.stdout.write(`将卸载以下 ${targets.length} 处:\n`);
  for (const t of targets) {
    process.stdout.write(
      `  ${t.path}  (${t.runtime}, ${scopeToString(t.scope)})\n`
    );
  }
  const ok = await confirm("确认卸载?");
  if (!ok) {
    process.stdout.write("cancelled.\n");
    return;
  }

  for (const t of targets) {
    removeOne(t);
    process.stdout.write(`✓ uninstalled ${skillName} from ${t.path}\n`);
  }
}

function uninstallSingleScope(
  skillName: string,
  opts: { scope?: string; runtime?: string }
): void {
  let runtime: Runtime;
  let scope: Scope;
  let target: string;
  try {
    runtime = resolveRuntime(opts.runtime);
    scope = parseScope(opts.scope);
    target = resolveTargetPath({ runtime, scope });
  } catch (e) {
    return emitError(e as TfsError);
  }

  const targetDir = join(target, skillName);
  if (!existsSync(targetDir)) {
    return emitError({
      error: "skill_not_found",
      message: `${targetDir} 不存在`,
      hint: "跑 tfs installed 看已装的 skill",
      exit_code: 1,
    });
  }

  const stamp = readStamp(join(targetDir, "SKILL.md"));
  if (stamp.status === "absent") {
    return emitError({
      error: "skill_not_found",
      message: `${targetDir} 不是 tranfu-skills 装的 (无 installed_by 戳)`,
      hint:
        "这看起来是手装的 skill, tfs uninstall 只删 tranfu-skills 装的; 手装请手动 rm",
      exit_code: 1,
    });
  }

  removeOne({ path: targetDir, runtime, scope });
  process.stdout.write(`✓ uninstalled ${skillName} from ${targetDir}\n`);
}
