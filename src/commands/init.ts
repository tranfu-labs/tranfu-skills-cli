import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fetchIndex } from "../lib/index-fetch.js";
import {
  resolveRuntime,
  detectAvailableRuntimes,
  userSkillDir,
  type Runtime,
} from "../lib/runtime.js";
import { runDoctor } from "../lib/doctor.js";
import { downloadSkillToTarget } from "../lib/skill-fetch.js";
import { emitError } from "../lib/errors.js";
import type { SkillEntry, TfsError } from "../types.js";

const META_SKILLS = ["tranfu-router", "tranfu-publish"];

const PRODUCT_NAME: Record<Runtime, string> = {
  "claude-code": "Claude Code",
  "codex": "Codex CLI",
};

interface InitOpts {
  runtime?: string;
  both?: boolean;
}

/**
 * TTY 交互: 探到 2 个 runtime 且无 --runtime/--both 时, 让用户选.
 * 非 TTY (AI agent / pipe) 返回 null → 上层 emit runtime_required.
 * 抽出来便于测试 mock.
 */
export async function _promptRuntimeChoice(
  available: Runtime[],
  out: (s: string) => void = (s) => process.stdout.write(s),
  isTty: boolean = !!(process.stdin.isTTY && process.stdout.isTTY),
  readQuestion?: (q: string) => Promise<string>
): Promise<Runtime | "both" | null> {
  if (!isTty) return null;
  let ask = readQuestion;
  if (!ask) {
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    ask = async (q: string) => {
      const a = await rl.question(q);
      rl.close();
      return a;
    };
  }
  out(`Detected ${available.length} runtimes. 装 meta-skill 到哪里?\n`);
  available.forEach((r, i) => out(`  [${i + 1}] ${r}\n`));
  out(`  [${available.length + 1}] both\n`);
  out(`  [${available.length + 2}] cancel\n`);
  const ansRaw = await ask(`选 1-${available.length + 2}: `);
  const ans = parseInt(ansRaw.trim(), 10);
  if (isNaN(ans) || ans < 1 || ans > available.length + 2) return null;
  if (ans === available.length + 2) return null; // cancel
  if (ans === available.length + 1) return "both";
  return available[ans - 1]!;
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

  // 2. 解析 runtimes (单/多/both)
  // 优先级: --both > --runtime > 单 runtime auto > TTY interactive > runtime_required error
  let runtimes: Runtime[];
  const available = detectAvailableRuntimes();

  if (opts.both) {
    if (available.length === 0) {
      return emitError({
        error: "runtime_required",
        message: "--both 需要至少 1 个 runtime 已初始化",
        hint: "先初始化 Claude Code 和/或 Codex CLI",
        exit_code: 1,
      });
    }
    runtimes = available;
  } else if (opts.runtime !== undefined) {
    try {
      runtimes = [resolveRuntime(opts.runtime)];
    } catch (e) {
      return emitError(e as TfsError);
    }
  } else if (available.length === 1) {
    runtimes = [available[0]!];
  } else if (available.length >= 2) {
    // Phase 7.4 双 runtime + 无 flag → TTY 交互, 非 TTY runtime_required
    const choice = await _promptRuntimeChoice(available);
    if (choice === null) {
      return emitError({
        error: "runtime_required",
        message: `检测到 ${available.length} 个 runtime: ${available.join(", ")}, 必须显式指定`,
        hint: "传 --runtime=claude-code|codex, 或 --both, 或在 TTY 中跑交互式选择",
        exit_code: 1,
      });
    }
    runtimes = choice === "both" ? available : [choice];
  } else {
    // 0 runtime — 但 doctor fatal=true 应已 abort, 这里是 safety net
    return emitError({
      error: "runtime_required",
      message: "未检测到任何 runtime",
      hint: "先初始化 Claude Code 或 Codex CLI",
      exit_code: 1,
    });
  }

  // 3. fetchIndex
  let index;
  try {
    index = await fetchIndex();
  } catch (e) {
    return emitError(e as TfsError);
  }

  // 4. 装两个 meta-skill 到每个目标 runtime (幂等)
  type ResultWithRuntime = SkillInstallResult & { runtime: Runtime };
  const results: ResultWithRuntime[] = [];

  for (const runtime of runtimes) {
    const target = userSkillDir(runtime);

    for (const skillName of META_SKILLS) {
      const skill = index.skills.find(
        (s: SkillEntry) => s.name === skillName
      );
      if (!skill) {
        results.push({ name: skillName, status: "missing", runtime });
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
          runtime,
        });
      } catch (e) {
        results.push({
          name: skillName,
          status: "failed",
          runtime,
          error: isTfsError(e) ? e.message : String(e),
        });
      }
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

  // 6. 成功输出 (跨 runtime 时按 runtime 分组渲染)
  for (const r of results) {
    const tag = runtimes.length > 1 ? ` (${r.runtime})` : "";
    process.stdout.write(`✓ ${r.status} ${r.name}${tag}\n`);
  }
  const productNames = runtimes.map((r) => PRODUCT_NAME[r]).join(" + ");
  process.stdout.write(
    `\nRestart ${productNames} 或开新会话 — router/publish meta-skill 会自动加载, 可直接说 "搜公司 skill ...".\n`
  );
}
