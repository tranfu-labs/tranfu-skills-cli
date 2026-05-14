import { runDoctor, type CheckStatus } from "../lib/doctor.js";
import { detectOutdatedCached } from "../lib/stale-check.js";

function statusIcon(s: CheckStatus): string {
  return s === "ok" ? "✓" : s === "warn" ? "⚠" : "✗";
}

/**
 * `tfs doctor`: 诊断本机环境.
 * slice-5: 末尾追汇总 `已装 N 个 skill, M 个 outdated`; --json 模式输出
 * {checks, ok, installed_count, outdated_count} (给 router skill 一并探健康度).
 * fatal check 失败 → exit 1; 仅 warn → exit 0 + 提示.
 */
export async function doctorCommand(opts: { json?: boolean }): Promise<void> {
  const result = runDoctor();

  // 调 detectOutdatedCached (silent on fail) 拿汇总
  let installedCount = 0;
  let outdatedCount = 0;
  try {
    const detection = await detectOutdatedCached();
    installedCount = detection.skills.length;
    outdatedCount = detection.skills.filter(
      (s) => s.status === "outdated"
    ).length;
  } catch {
    // silent — count 留 0, 不影响 doctor 主功能
  }

  if (opts.json) {
    const payload = {
      checks: result.checks,
      ok: result.ok,
      installed_count: installedCount,
      outdated_count: outdatedCount,
    };
    process.stdout.write(JSON.stringify(payload) + "\n");
    if (!result.ok) process.exit(1);
    return;
  }

  for (const c of result.checks) {
    process.stdout.write(
      `${statusIcon(c.status)} ${c.name}: ${c.message}\n`
    );
  }

  if (!result.ok) {
    process.stdout.write(
      "\nFatal check(s) failed. 修上面再跑 tfs install / tfs init.\n"
    );
    process.exit(1);
  }

  const warnings = result.checks.filter((c) => c.status === "warn");
  if (warnings.length > 0) {
    process.stdout.write(
      `\n${warnings.length} warning(s). 不阻塞使用, 但建议处理.\n`
    );
  } else {
    process.stdout.write("\nAll checks passed.\n");
  }

  // 末尾汇总 (DoD-007 text 部分)
  const summary =
    outdatedCount > 0
      ? `\n已装 ${installedCount} 个 skill, ${outdatedCount} 个 outdated\n`
      : `\n已装 ${installedCount} 个 skill\n`;
  process.stdout.write(summary);
}
