import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fetchIndex } from "../lib/index-fetch.js";
import { resolveRuntime } from "../lib/runtime.js";
import { parseScope, resolveTargetPath } from "../lib/paths.js";
import { readStamp } from "../lib/stamp.js";
import { downloadSkillToTarget } from "../lib/skill-fetch.js";
import { emitError } from "../lib/errors.js";
import type { TfsError } from "../types.js";

/** Type guard: 区分 lib throw 的 TfsError 与 fs/network 原生 Error */
function isTfsError(e: unknown): e is TfsError {
  return (
    typeof e === "object" &&
    e !== null &&
    "error" in e &&
    "message" in e &&
    "exit_code" in e
  );
}

export async function installCommand(
  skillName: string,
  opts: { scope?: string; runtime?: string; force?: boolean }
): Promise<void> {
  // 1. 解析 runtime / scope / target
  let runtime: ReturnType<typeof resolveRuntime>;
  let target: string;
  try {
    runtime = resolveRuntime(opts.runtime);
    const scope = parseScope(opts.scope);
    target = resolveTargetPath({ runtime, scope });
  } catch (e) {
    return emitError(e as TfsError);
  }

  // 2. fetch index
  let index;
  try {
    index = await fetchIndex();
  } catch (e) {
    return emitError(e as TfsError);
  }

  // 3. 找到 skill
  const skill = index.skills.find((s) => s.name === skillName);
  if (!skill) {
    return emitError({
      error: "skill_not_found",
      message: `skill "${skillName}" 不在公司库 index 中`,
      hint: `跑 tfs search "${skillName}" 看候选`,
      exit_code: 1,
    });
  }

  // 4. target 已存在 → 读戳判断行为
  //    Phase 3.3 scope: 无戳 + --force → rm + 继续; 其他都 skill_already_installed
  //    Phase 3.4/3.5 留: partial stamp / intact stamp 的 update / noop 路径
  const targetDir = join(target, skillName);
  if (existsSync(targetDir)) {
    const stamp = readStamp(join(targetDir, "SKILL.md"));
    if (stamp.status === "intact") {
      // Phase 3.5: tranfu-skills 装过的完整 skill
      if (stamp.data.installed_version === skill.sha) {
        // sha 一致 → noop (V3 §3): 不写文件, 不重新 fetch, exit 0
        process.stdout.write(
          `✓ ${skillName} already up-to-date (sha=${skill.sha.slice(0, 7)})\n`
        );
        return;
      }
      // sha 不一致 → update: 直接覆盖, 不需要 --force
      rmSync(targetDir, { recursive: true, force: true });
    } else if (
      (stamp.status === "absent" || stamp.status === "partial") &&
      opts.force
    ) {
      // Phase 3.3 (absent) / Phase 3.4 (partial) — --force 覆盖
      rmSync(targetDir, { recursive: true, force: true });
    } else {
      // absent/partial 无 --force → refuse
      const hint =
        stamp.status === "absent"
          ? "用 --force 覆盖 (会先 rm 该目录, 销毁性)."
          : "检测到不完整的安装戳 (缺 installed_version 等). 用 --force 重写它 (rm 旧目录 + 重装).";
      return emitError({
        error: "skill_already_installed",
        message: `${targetDir} 已存在 (stamp: ${stamp.status})`,
        hint,
        exit_code: 1,
      });
    }
  }

  // 5. 下载 skill (staging + atomic rename, 失败 rollback) - 由 lib/skill-fetch 实现
  try {
    await downloadSkillToTarget(skill, target, targetDir, {
      installed_by: "tranfu-skills",
      installed_version: skill.sha,
      installed_at: new Date().toISOString().slice(0, 10),
      installed_source: skill.type,
    });
  } catch (e) {
    if (isTfsError(e)) {
      return emitError(e);
    }
    return emitError({
      error: "internal_error",
      message: `install 内部错误: ${e instanceof Error ? e.message : String(e)}`,
      hint: "可能是文件系统问题 (跨分区 rename / 权限). 请报 issue.",
      exit_code: 3,
    });
  }

  // 6. 成功输出 (V3 §8.1)
  const restartHint =
    runtime === "claude-code"
      ? "Restart Claude Code or open a new session to load this skill."
      : "Restart Codex CLI or open a new session to load this skill.";
  process.stdout.write(
    `✓ installed ${skillName} to ${targetDir}\n  ${restartHint}\n`
  );
}
