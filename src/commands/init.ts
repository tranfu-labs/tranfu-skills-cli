import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fetchIndex } from "../lib/index-fetch.js";
import {
  resolveRuntime,
  userSkillDir,
  type Runtime,
} from "../lib/runtime.js";
import { runDoctor } from "../lib/doctor.js";
import { downloadSkillToTarget } from "../lib/skill-fetch.js";
import { emitError } from "../lib/errors.js";
import type { SkillEntry, TfsError } from "../types.js";

const META_SKILLS = ["tranfu-router", "tranfu-publish"];

interface InitOpts {
  runtime?: string;
}

type ResultStatus = "installed" | "refreshed" | "missing" | "failed";

interface SkillInstallResult {
  name: string;
  status: ResultStatus;
  error?: string;
}

function isTfsError(e: unknown): e is TfsError {
  return (
    typeof e === "object" &&
    e !== null &&
    "error" in e &&
    "message" in e &&
    "exit_code" in e
  );
}

/**
 * Phase 7.3 + 7.5: init 单 runtime + 幂等覆盖.
 * Phase 7.4 (双 runtime 交互) 留独立 micro.
 *
 * 流程:
 * 1. runDoctor() 内部调用, 任何 fatal fail → init_precondition_failed
 * 2. resolveRuntime: 单 → 用之; 2 + 无 --runtime → runtime_required (7.4 改交互)
 * 3. fetchIndex → 找 tranfu-router + tranfu-publish
 * 4. 装到 target user skill dir; 已存在 → rmSync + 重装 (refreshed, 幂等)
 * 5. 任一 missing / failed → 报错; 全 OK → ✓ + 重启 CLI 提示
 */
export async function initCommand(opts: InitOpts): Promise<void> {
  // 1. doctor (SDK)
  const dr = runDoctor();
  if (!dr.ok) {
    const fatalFails = dr.checks.filter(
      (c) => c.fatal && c.status !== "ok"
    );
    return emitError({
      error: "init_precondition_failed",
      message: `Doctor 检测到 ${fatalFails.length} 个 fatal 问题: ${fatalFails.map((c) => `${c.name} (${c.message})`).join("; ")}`,
      hint: "跑 tfs doctor 看详情, 修上面再 init",
      exit_code: 1,
    });
  }

  // 2. resolveRuntime (Phase 7.3 不带交互; 7.4 改为多 runtime 时交互)
  let runtime: Runtime;
  try {
    runtime = resolveRuntime(opts.runtime);
  } catch (e) {
    return emitError(e as TfsError);
  }

  // 3. fetchIndex
  let index;
  try {
    index = await fetchIndex();
  } catch (e) {
    return emitError(e as TfsError);
  }

  // 4. 装两个 meta-skill (幂等)
  const target = userSkillDir(runtime);
  const results: SkillInstallResult[] = [];

  for (const skillName of META_SKILLS) {
    const skill = index.skills.find(
      (s: SkillEntry) => s.name === skillName
    );
    if (!skill) {
      results.push({ name: skillName, status: "missing" });
      continue;
    }

    const targetDir = join(target, skillName);
    const wasInstalled = existsSync(targetDir);

    // Phase 7.5 幂等: 已装 → rm + 重装, 输出 refreshed
    if (wasInstalled) {
      rmSync(targetDir, { recursive: true, force: true });
    }

    try {
      await downloadSkillToTarget(skill, target, targetDir, {
        installed_by: "tranfu-skills",
        installed_version: skill.sha,
        installed_at: new Date().toISOString().slice(0, 10),
        installed_source: "meta",
      });
      results.push({
        name: skillName,
        status: wasInstalled ? "refreshed" : "installed",
      });
    } catch (e) {
      results.push({
        name: skillName,
        status: "failed",
        error: isTfsError(e) ? e.message : String(e),
      });
    }
  }

  // 5. 错误处理
  const missing = results.filter((r) => r.status === "missing");
  const failed = results.filter((r) => r.status === "failed");

  if (missing.length > 0) {
    return emitError({
      error: "skill_not_found",
      message: `公司库 index 中找不到必需的 meta-skill: ${missing.map((r) => r.name).join(", ")}`,
      hint:
        "公司库可能尚未上 tranfu-router / tranfu-publish; 联系维护者; 或检查 tfs --version 是否最新",
      exit_code: 1,
    });
  }
  if (failed.length > 0) {
    return emitError({
      error: "internal_error",
      message: `init 部分失败: ${failed.map((r) => `${r.name}: ${r.error}`).join("; ")}`,
      hint:
        "重试 init; 或手动跑 tfs install tranfu-router --force && tfs install tranfu-publish --force",
      exit_code: 3,
    });
  }

  // 6. 成功输出
  for (const r of results) {
    process.stdout.write(`✓ ${r.status} ${r.name}\n`);
  }
  const restartHint =
    runtime === "claude-code"
      ? "Restart Claude Code or open a new session — router/publish meta-skill 会自动加载, 可直接说 '搜公司 skill ...'."
      : "Restart Codex CLI or open a new session — router/publish meta-skill 会自动加载, 可直接说 '搜公司 skill ...'.";
  process.stdout.write(`\n${restartHint}\n`);
}
