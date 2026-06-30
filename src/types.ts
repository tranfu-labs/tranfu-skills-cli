import type { Runtime } from "./lib/runtime.js";
import type { Scope } from "./lib/paths.js";

export type SkillType = "meta" | "own" | "external";

export interface SkillEntry {
  name: string;
  type: SkillType;
  description: string;
  path: string;
  files: string[];
  sha: string;
  source_url?: string; // 仅 external
}

export interface IndexJson {
  version: 1;
  generated_at: string; // ISO 8601
  skills: SkillEntry[];
}

export interface TfsError {
  error: string;
  message: string;
  hint?: string;
  exit_code: 1 | 2 | 3;
}

export interface SkillUpdateResult {
  name: string;
  from: string;
  to: string;
  status:
    | "updated"
    | "noop"
    | "outdated"
    | "deleted-upstream"
    | "deleted-upstream-acked"
    | "failed";
  runtime: Runtime;
  /** scope 缺省视为 {kind:"user"} (兼容旧调用). hermes 多 profile 场景 MUST 显式带. */
  scope?: Scope;
  error?: string;
}
