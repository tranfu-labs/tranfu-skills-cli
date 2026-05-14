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
