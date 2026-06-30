import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Runtime = "claude-code" | "codex" | "hermes";

export const ALL_RUNTIMES: Runtime[] = ["claude-code", "codex", "hermes"];

/** Runtime → user 级根目录 (含 `.claude` / `.codex` / `.hermes`, 不含 `/skills`) */
const RUNTIME_HOME_DIRS: Record<Runtime, string> = {
  "claude-code": join(homedir(), ".claude"),
  "codex": join(homedir(), ".codex"),
  "hermes": join(homedir(), ".hermes"),
};

/** 探测本机已初始化的 runtime (基于 ~/.claude 或 ~/.codex 是否存在) */
export function detectAvailableRuntimes(): Runtime[] {
  return ALL_RUNTIMES.filter((r) => existsSync(RUNTIME_HOME_DIRS[r]));
}

/**
 * 解析 runtime: 显式 explicit 优先, 否则探测.
 *
 * 返回 Runtime 或 throw plain TfsError 对象 (与 index-fetch.ts 一致的模式).
 *
 * 行为表 (对齐 V3 §4 锁定):
 * - explicit 给了, 值合法 → 用 explicit (不校验目录存在, 留给 install 等命令报 permission_denied)
 * - explicit 给了, 值非法 → throw runtime_invalid
 * - 否则探测: 0 个 → throw runtime_required + hint "初始化对应 CLI"
 *           1 个 → 用之, 静默
 *           ≥2 个 → throw runtime_required + hint "传 --runtime"
 */
export function resolveRuntime(explicit?: string): Runtime {
  if (explicit !== undefined) {
    if (
      explicit !== "claude-code" &&
      explicit !== "codex" &&
      explicit !== "hermes"
    ) {
      throw {
        error: "runtime_invalid",
        message: `--runtime 必须是 claude-code / codex / hermes, 当前: ${explicit}`,
        hint: "改 --runtime=claude-code 或 --runtime=codex 或 --runtime=hermes",
        exit_code: 1,
      };
    }
    return explicit;
  }

  const available = detectAvailableRuntimes();
  if (available.length === 0) {
    throw {
      error: "runtime_required",
      message: "未检测到任何 runtime (~/.claude, ~/.codex, ~/.hermes 都不存在)",
      hint: "先初始化 Claude Code / Codex CLI / Hermes Agent; 或显式传 --runtime=claude-code|codex|hermes",
      exit_code: 1,
    };
  }
  if (available.length === 1) {
    return available[0]!;
  }
  // ≥2 个: 不静默 default, 强制显式
  throw {
    error: "runtime_required",
    message: `检测到 ${available.length} 个 runtime: ${available.join(", ")}, 必须显式指定`,
    hint: "传 --runtime=claude-code|codex|hermes",
    exit_code: 1,
  };
}

/** 给已知 runtime 返回 user 级 skill 目录 (供 install/list/etc 用) */
export function userSkillDir(runtime: Runtime): string {
  return join(RUNTIME_HOME_DIRS[runtime], "skills");
}
