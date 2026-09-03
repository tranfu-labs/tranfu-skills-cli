import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import type { Runtime } from "./runtime.js";
import { userSkillDir } from "./runtime.js";
import { PROFILE_NAME_RE } from "./hermes.js";

/**
 * Scope 用 discriminated union. CLI flag 字面值映射:
 *   --scope user          → { kind: "user" }
 *   --scope project       → { kind: "project" }    (仅 claude-code / codex)
 *   --scope profile:<n>   → { kind: "profile", name }  (仅 hermes)
 */
export type Scope =
  | { kind: "user" }
  | { kind: "project" }
  | { kind: "profile"; name: string };

export const SCOPE_USER: Scope = { kind: "user" };
export const SCOPE_PROJECT: Scope = { kind: "project" };

/** 给老代码迁移用: 二元 user/project enum, 不含 profile (本项目不再公开导出, 仅 install/uninstall TTY 选择菜单内部用) */
export const ALL_BASIC_SCOPES: ("user" | "project")[] = ["user", "project"];

/** CLI 字面值序列化 (输出渲染时用) */
export function scopeToString(s: Scope): string {
  if (s.kind === "user") return "user";
  if (s.kind === "project") return "project";
  return `profile:${s.name}`;
}

/** 两个 Scope 是否相等 (用于 filter / registry 去重) */
export function scopeEquals(a: Scope, b: Scope): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "profile" && b.kind === "profile") return a.name === b.name;
  return true;
}

/**
 * 纯解析 --scope flag 字符串, 不接 runtime (runtime-agnostic).
 * 业务规则校验 (如 claude-code + profile 非法) 在 resolveTargetPath 里做,
 * 因为只在"实际装到/读到目标位置"时这种组合才真有问题; filter 等场景可以宽松接受.
 */
export function parseScope(raw: string | undefined, defaultScope: Scope = SCOPE_USER): Scope {
  if (raw === undefined) return defaultScope;
  if (raw === "user") return SCOPE_USER;
  if (raw === "project") return SCOPE_PROJECT;
  if (raw.startsWith("profile:")) {
    const name = raw.slice("profile:".length);
    if (!name || !PROFILE_NAME_RE.test(name)) {
      throw {
        error: "scope_invalid",
        message: `--scope profile:<name> 的 name 必须匹配 [a-zA-Z0-9_-]+, 当前: "${name}"`,
        hint: "改用合法 profile 名 (字母数字+下划线+连字符)",
        exit_code: 1,
      };
    }
    return { kind: "profile", name };
  }
  throw {
    error: "scope_invalid",
    message: `--scope 必须是 user / project / profile:<name>, 当前: ${raw}`,
    hint: "改 --scope=user 或 --scope=project 或 --scope=profile:<name>",
    exit_code: 1,
  };
}

/** 给定 runtime + scope, 返回 skill 应该写到哪个目录的绝对路径. 不创建目录, 不写入. */
export function resolveTargetPath(opts: {
  runtime: Runtime;
  scope: Scope;
  cwd?: string;
}): string {
  const { runtime, scope } = opts;

  // hermes 分支: scope.user → ~/.hermes/skills/tranfu;
  //              scope.profile:<n> → ~/.hermes/profiles/<n>/skills/tranfu;
  //              scope.project → 报错 (hermes 无 per-cwd 概念)
  if (runtime === "hermes") {
    if (scope.kind === "project") {
      throw {
        error: "scope_unsupported",
        message: "hermes 不支持 --scope project (hermes 没有 per-cwd 概念)",
        hint: "改 --scope=user 或 --scope=profile:<name>",
        exit_code: 1,
      };
    }
    const base =
      scope.kind === "user"
        ? join(homedir(), ".hermes", "skills", "tranfu")
        : join(homedir(), ".hermes", "profiles", scope.name, "skills", "tranfu");
    return base;
  }

  // claude-code / codex 分支: 不接受 profile scope
  if (scope.kind === "profile") {
    throw {
      error: "scope_unsupported",
      message: `${runtime} 不支持 --scope profile:<name> (profile 仅 hermes 支持)`,
      hint: "改 --scope=user 或 --scope=project, 或换 --runtime=hermes",
      exit_code: 1,
    };
  }

  if (scope.kind === "user") {
    return userSkillDir(runtime);
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
  const subdir = runtime === "claude-code" ? ".claude" : ".agents";
  return join(gitRoot, subdir, "skills");
}
