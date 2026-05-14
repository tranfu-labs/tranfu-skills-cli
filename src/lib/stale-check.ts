import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { SkillUpdateResult } from "../types.js";
import { fetchIndex } from "./index-fetch.js";
import { ALL_RUNTIMES } from "./runtime.js";
import { resolveTargetPath } from "./paths.js";
import { readStamp } from "./stamp.js";
import { readAck } from "./ack.js";

export interface DetectOutdatedResult {
  skills: SkillUpdateResult[];
  checked_at: string;
  cached: boolean;
}

/**
 * 扫描本机所有 runtime 下 user-scope 已装的 tfs skill, 与远端 index 比对 sha.
 * 返回 stamped skill 的检测结果 (含 noop / outdated / deleted-upstream 全部状态).
 * 不写 cache 文件 (slice-1 阶段 cached 恒 false; slice-2 加 wrapper 落地).
 * 网络挂 → throws TfsError (走 emitError); silent degrade 不在此层.
 */
export async function detectOutdated(): Promise<DetectOutdatedResult> {
  const index = await fetchIndex();
  const ackedDeletions = readAck();
  const skills: SkillUpdateResult[] = [];

  for (const runtime of ALL_RUNTIMES) {
    let dir: string;
    try {
      dir = resolveTargetPath({ runtime, scope: "user" });
    } catch {
      continue;
    }

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }

    for (const name of entries) {
      if (name.startsWith(".")) continue;
      const skillDir = join(dir, name);
      try {
        if (!statSync(skillDir).isDirectory()) continue;
      } catch {
        continue;
      }

      const stamp = readStamp(join(skillDir, "SKILL.md"));
      if (stamp.status === "absent") continue;

      const installedVersion =
        stamp.status === "intact"
          ? stamp.data.installed_version
          : stamp.partial.installed_version ?? "";

      const indexEntry = index.skills.find((s) => s.name === name);
      if (!indexEntry) {
        skills.push({
          name,
          from: installedVersion,
          to: installedVersion,
          status: ackedDeletions.has(name)
            ? "deleted-upstream-acked"
            : "deleted-upstream",
          runtime,
        });
        continue;
      }

      if (indexEntry.sha === installedVersion) {
        skills.push({
          name,
          from: installedVersion,
          to: installedVersion,
          status: "noop",
          runtime,
        });
        continue;
      }

      skills.push({
        name,
        from: installedVersion,
        to: indexEntry.sha,
        status: "outdated",
        runtime,
      });
    }
  }

  return {
    skills,
    checked_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    cached: false,
  };
}
