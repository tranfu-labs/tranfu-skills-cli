import { runDoctor, type CheckStatus } from "../lib/doctor.js";

function statusIcon(s: CheckStatus): string {
  return s === "ok" ? "✓" : s === "warn" ? "⚠" : "✗";
}

/**
 * `tfs doctor`: 诊断本机环境.
 * 不支持 --json (人话诊断给 user 看, AI 不会调).
 * fatal check 失败 → exit 1; 仅 warn → exit 0 + 提示.
 */
export async function doctorCommand(_opts: {}): Promise<void> {
  const result = runDoctor();

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
}
