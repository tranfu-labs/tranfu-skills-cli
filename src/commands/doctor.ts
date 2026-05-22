import { runDoctor, type CheckStatus, type DoctorCheck } from "../lib/doctor.js";
import { detectOutdatedCached } from "../lib/stale-check.js";

function statusIcon(s: CheckStatus): string {
  return s === "ok" ? "✓" : s === "warn" ? "⚠" : "✗";
}

/**
 * 把 stale-check 结果折成一项 DoctorCheck (status=warn 当有 outdated).
 * 之前是末尾一行 hint, agent 走 INSTALL.md 4/4 ✓ 时常忽略, 这里提升为 ⚠ 检查项,
 * 让 "任一 ⚠ 都按 doctor 提示处理" 的现有约定自然 cover 升级路径.
 */
function buildSkillsUpToDateCheck(
  installedCount: number,
  outdatedCount: number
): DoctorCheck {
  if (outdatedCount > 0) {
    return {
      name: "skills-up-to-date",
      status: "warn",
      message: `已装 ${installedCount} 个 skill, ${outdatedCount} 个 outdated → 跑 \`tfs update\` 同步`,
      fatal: false,
    };
  }
  return {
    name: "skills-up-to-date",
    status: "ok",
    message: `已装 ${installedCount} 个 skill, 全部 up-to-date`,
    fatal: false,
  };
}

/**
 * `tfs doctor`: 诊断本机环境.
 * 5 项 check: node-version / runtime / tfs-in-path / legacy-cache / skills-up-to-date.
 * stale-check 探测失败 (网络等) 时, skills-up-to-date 不出现 (回到 4 项), --json
 * 仍带 installed_count=0/outdated_count=0 给上层 router skill.
 * fatal check 失败 → exit 1; 仅 warn → exit 0 + 提示.
 */
export async function doctorCommand(opts: { json?: boolean }): Promise<void> {
  const result = runDoctor();

  let installedCount = 0;
  let outdatedCount = 0;
  let detectionOk = false;
  try {
    const detection = await detectOutdatedCached();
    installedCount = detection.skills.length;
    outdatedCount = detection.skills.filter(
      (s) => s.status === "outdated"
    ).length;
    detectionOk = true;
  } catch {
    // silent — count 留 0, skills-up-to-date 这一项跳过, doctor 主功能不受影响
  }

  const allChecks: DoctorCheck[] = detectionOk
    ? [...result.checks, buildSkillsUpToDateCheck(installedCount, outdatedCount)]
    : result.checks;
  // skills-up-to-date 是 non-fatal, 不参与 ok 判断 — ok 仍由 runDoctor() 给
  const ok = result.ok;

  if (opts.json) {
    const payload = {
      checks: allChecks,
      ok,
      installed_count: installedCount,
      outdated_count: outdatedCount,
    };
    process.stdout.write(JSON.stringify(payload) + "\n");
    if (!ok) process.exit(1);
    return;
  }

  for (const c of allChecks) {
    process.stdout.write(
      `${statusIcon(c.status)} ${c.name}: ${c.message}\n`
    );
  }

  if (!ok) {
    process.stdout.write(
      "\nFatal check(s) failed. 修上面再跑 tfs install / tfs init.\n"
    );
    process.exit(1);
  }

  const warnings = allChecks.filter((c) => c.status === "warn");
  if (warnings.length > 0) {
    process.stdout.write(
      `\n${warnings.length} warning(s). 不阻塞使用, 但建议处理.\n`
    );
  } else {
    process.stdout.write("\nAll checks passed.\n");
  }
}
