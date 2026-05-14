import { join } from "node:path";
import { execSync } from "node:child_process";
import type { Runtime } from "./runtime.js";
import { userSkillDir } from "./runtime.js";

export type Scope = "user" | "project";

export const ALL_SCOPES: Scope[] = ["user", "project"];

/** 给定 runtime + scope, 返回 skill 应该写到哪个目录的绝对路径. 不创建目录, 不写入. */
export function resolveTargetPath(opts: {
  runtime: Runtime;
  scope: Scope;
  cwd?: string;
}): string {
  if (opts.scope === "user") {
    return userSkillDir(opts.runtime);
  }
  // project: git-root/.<runtime>/skills/
  const cwd = opts.cwd ?? process.cwd();
  let gitRoot: string;
  try {
    gitRoot = execSync("git rev-parse --show-toplevel", {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    throw {
      error: "git_repo_required",
      message: `--scope project 需要在 git 仓库下运行 (当前 cwd: ${cwd})`,
      hint: "cd 到 git repo 根, 或改用 --scope user",
      exit_code: 1,
    };
  }
  const subdir = opts.runtime === "claude-code" ? ".claude" : ".codex";
  return join(gitRoot, subdir, "skills");
}

/** 校验 --scope flag 字符串, 默认 user. 非法值 throw scope_invalid */
export function parseScope(raw: string | undefined, defaultScope: Scope = "user"): Scope {
  if (raw === undefined) return defaultScope;
  if (raw !== "user" && raw !== "project") {
    throw {
      error: "scope_invalid",
      message: `--scope 必须是 user 或 project, 当前: ${raw}`,
      hint: "改 --scope=user 或 --scope=project",
      exit_code: 1,
    };
  }
  return raw;
}
