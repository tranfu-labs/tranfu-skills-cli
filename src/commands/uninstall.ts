import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { resolveRuntime } from "../lib/runtime.js";
import { parseScope, resolveTargetPath } from "../lib/paths.js";
import { readStamp } from "../lib/stamp.js";
import { emitError } from "../lib/errors.js";
import type { TfsError } from "../types.js";

export async function uninstallCommand(
  skillName: string,
  opts: { scope?: string; runtime?: string }
): Promise<void> {
  let runtime: ReturnType<typeof resolveRuntime>;
  let target: string;
  try {
    runtime = resolveRuntime(opts.runtime);
    const scope = parseScope(opts.scope);
    target = resolveTargetPath({ runtime, scope });
  } catch (e) {
    return emitError(e as TfsError);
  }

  const targetDir = join(target, skillName);
  if (!existsSync(targetDir)) {
    return emitError({
      error: "skill_not_found",
      message: `${targetDir} 不存在`,
      hint: "跑 tfs list 看已装的 skill",
      exit_code: 1,
    });
  }

  // 只删 tranfu-skills 装的 skill (intact / partial 戳). 无戳 (用户手装) 不动.
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

  rmSync(targetDir, { recursive: true, force: true });
  process.stdout.write(`✓ uninstalled ${skillName} from ${targetDir}\n`);
}
