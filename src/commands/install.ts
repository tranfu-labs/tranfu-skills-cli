import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fetchIndex } from "../lib/index-fetch.js";
import {
  resolveRuntime,
  detectAvailableRuntimes,
  type Runtime,
} from "../lib/runtime.js";
import {
  parseScope,
  resolveTargetPath,
  SCOPE_USER,
  SCOPE_PROJECT,
  type Scope,
} from "../lib/paths.js";
import { detectActiveProfile } from "../lib/hermes.js";
import { readStamp } from "../lib/stamp.js";
import { downloadSkillToTarget } from "../lib/skill-fetch.js";
import { emitError } from "../lib/errors.js";
import { addEntry } from "../lib/registry.js";
import { selectFromList, isInteractive } from "../lib/prompt.js";
import type { TfsError } from "../types.js";

export async function _resolveRuntimeInteractive(
  explicit: string | undefined
): Promise<Runtime> {
  if (explicit !== undefined) return resolveRuntime(explicit);
  const available = detectAvailableRuntimes();
  if (available.length <= 1) return resolveRuntime(undefined);
  if (!isInteractive()) return resolveRuntime(undefined);
  const picked = await selectFromList({
    question: `检测到 ${available.length} 个 runtime, 装到哪个?`,
    choices: available,
  });
  if (picked === "quit" || picked === "all") {
    throw {
      error: "runtime_required",
      message: "用户取消",
      hint: "再次跑命令选择 runtime, 或显式 --runtime=claude-code|codex|hermes",
      exit_code: 1,
    };
  }
  return available[picked]!;
}

/**
 * 解析 install 的 scope. 行为按 runtime 分流:
 *   - 显式 --scope: 走 parseScope (校验字面值 + 把 profile:<n> 拆出); resolveTargetPath 再校验非法组合 (e.g. claude-code + profile)
 *   - hermes 未传 --scope: 调 detectActiveProfile, 自动落 active profile 或默认; 不弹 TTY 选择
 *   - claude-code / codex 未传 --scope: TTY 走 user/project 二选一; 非 TTY 默认 user
 * 返回 scope 与 (可选) detectedHint 让 install 主流程在装前打印.
 */
export async function _resolveScopeInteractive(
  explicit: string | undefined,
  runtime: Runtime
): Promise<{ scope: Scope; detectedHint?: string }> {
  if (explicit !== undefined) return { scope: parseScope(explicit) };

  if (runtime === "hermes") {
    const active = detectActiveProfile();
    if (active) {
      return {
        scope: { kind: "profile", name: active },
        detectedHint: `· detected hermes profile: ${active}\n`,
      };
    }
    return {
      scope: SCOPE_USER,
      detectedHint: `· no active hermes profile, installing to default (~/.hermes/skills/tranfu/)\n`,
    };
  }

  // claude-code / codex
  if (!isInteractive()) return { scope: SCOPE_USER }; // 非 TTY 默认 user, 零漂移
  const subdir = runtime === "claude-code" ? ".claude" : ".agents";
  const picked = await selectFromList({
    question: "装到哪个 scope?",
    choices: [
      `user (~/${subdir}/skills)`,
      `project (git-root/${subdir}/skills)`,
    ],
  });
  if (picked === "quit" || picked === "all") {
    throw {
      error: "scope_invalid",
      message: "用户取消",
      hint: "再次跑命令选择 scope, 或显式 --scope=user|project",
      exit_code: 1,
    };
  }
  return { scope: picked === 0 ? SCOPE_USER : SCOPE_PROJECT };
}

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

const PRODUCT_NAME: Record<Runtime, string> = {
  "claude-code": "Claude Code",
  "codex": "Codex CLI",
  "hermes": "Hermes Agent",
};

export async function installCommand(
  skillName: string,
  opts: { scope?: string; runtime?: string; force?: boolean }
): Promise<void> {
  // 1. 解析 runtime / scope / target (TTY 交互, 非 TTY 走原 throw / 默认 user)
  let runtime: Runtime;
  let scope: Scope;
  let target: string;
  let detectedHint: string | undefined;
  try {
    runtime = await _resolveRuntimeInteractive(opts.runtime);
    const r = await _resolveScopeInteractive(opts.scope, runtime);
    scope = r.scope;
    detectedHint = r.detectedHint;
    target = resolveTargetPath({ runtime, scope });
  } catch (e) {
    return emitError(e as TfsError);
  }
  if (detectedHint) process.stdout.write(detectedHint);

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
  const installedAt = new Date().toISOString().slice(0, 10);
  try {
    await downloadSkillToTarget(skill, target, targetDir, {
      installed_by: "tranfu-skills",
      installed_version: skill.sha,
      installed_at: installedAt,
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

  // 6. 写 registry (反向索引 cache; 失败不致命, silent degrade)
  try {
    addEntry({
      name: skillName,
      runtime,
      scope,
      path: targetDir,
      installed_version: skill.sha,
      installed_at: installedAt,
    });
  } catch {
    // registry 写失败不影响 install 主功能, 下次 read 时 bootstrap 会重建
  }

  // 7. 成功输出 (V3 §8.1)
  const restartHint = `Restart ${PRODUCT_NAME[runtime]} or open a new session to load this skill.`;
  process.stdout.write(
    `✓ installed ${skillName} to ${targetDir}\n  ${restartHint}\n`
  );
}
