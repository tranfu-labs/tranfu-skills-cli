import { readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fetchIndex } from "../lib/index-fetch.js";
import { ALL_RUNTIMES, type Runtime } from "../lib/runtime.js";
import { resolveTargetPath } from "../lib/paths.js";
import { readStamp } from "../lib/stamp.js";
import { downloadSkillToTarget } from "../lib/skill-fetch.js";
import { emitError } from "../lib/errors.js";
import {
  getGlobalVersion,
  getRegistryLatest,
  installGlobalLatest,
} from "../lib/npm.js";
import type { SkillEntry, TfsError } from "../types.js";

const PKG_NAME = "tranfu-skills";

interface SelfResult {
  from: string;
  to: string;
  status?: "noop";
}

interface SkillUpdateResult {
  name: string;
  from: string;
  to: string;
  status: "updated" | "noop" | "deleted-upstream" | "failed";
  runtime: Runtime;
  error?: string;
}

interface UpdateOpts {
  self?: boolean;
  skillsOnly?: boolean;
  json?: boolean;
}

function isTfsError(e: unknown): e is TfsError {
  return (
    typeof e === "object" &&
    e !== null &&
    "error" in e &&
    "message" in e &&
    "exit_code" in e
  );
}

async function doSelfUpdate(): Promise<SelfResult | null> {
  const from = getGlobalVersion(PKG_NAME);
  const latest = getRegistryLatest(PKG_NAME);

  if (from && latest && from === latest) {
    return { from, to: from, status: "noop" };
  }

  installGlobalLatest(PKG_NAME); // 抛错由调用方包成 internal_error

  const to = getGlobalVersion(PKG_NAME) ?? latest ?? "unknown";
  return { from: from ?? "unknown", to };
}

async function doSkillsUpdate(): Promise<SkillUpdateResult[]> {
  const index = await fetchIndex();
  const results: SkillUpdateResult[] = [];

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

      const indexEntry = index.skills.find(
        (s: SkillEntry) => s.name === name
      );
      if (!indexEntry) {
        results.push({
          name,
          from: installedVersion,
          to: installedVersion,
          status: "deleted-upstream",
          runtime,
        });
        continue;
      }

      if (indexEntry.sha === installedVersion) {
        results.push({
          name,
          from: installedVersion,
          to: installedVersion,
          status: "noop",
          runtime,
        });
        continue;
      }

      // sha 不一致 → 更新 (rm 旧 + downloadSkillToTarget)
      try {
        rmSync(skillDir, { recursive: true, force: true });
        await downloadSkillToTarget(indexEntry, dir, skillDir, {
          installed_by: "tranfu-skills",
          installed_version: indexEntry.sha,
          installed_at: new Date().toISOString().slice(0, 10),
          installed_source: indexEntry.type,
        });
        results.push({
          name,
          from: installedVersion,
          to: indexEntry.sha,
          status: "updated",
          runtime,
        });
      } catch (e) {
        results.push({
          name,
          from: installedVersion,
          to: indexEntry.sha,
          status: "failed",
          runtime,
          error: isTfsError(e) ? e.message : String(e),
        });
      }
    }
  }
  return results;
}

export async function updateCommand(opts: UpdateOpts): Promise<void> {
  // 默认 = both; --self = self only; --skills-only = skills only
  const doSelf = opts.skillsOnly !== true;
  const doSkills = opts.self !== true;

  let selfResult: SelfResult | null = null;
  if (doSelf) {
    try {
      selfResult = await doSelfUpdate();
    } catch (err) {
      return emitError({
        error: "internal_error",
        message: `npm install -g ${PKG_NAME}@latest 失败: ${
          err instanceof Error ? err.message : String(err)
        }`,
        hint:
          "检查 npm 是否可用 / 权限是否 OK; 或手动跑 npm install -g tranfu-skills@latest",
        exit_code: 3,
      });
    }
  }

  let skillResults: SkillUpdateResult[] = [];
  if (doSkills) {
    try {
      skillResults = await doSkillsUpdate();
    } catch (e) {
      return emitError(e as TfsError);
    }
  }

  // JSON 输出
  if (opts.json) {
    process.stdout.write(
      JSON.stringify({
        self: selfResult,
        skills: skillResults.map((r) => ({
          name: r.name,
          from: r.from,
          to: r.to,
          status: r.status,
          ...(r.runtime ? { runtime: r.runtime } : {}),
          ...(r.error ? { error: r.error } : {}),
        })),
      }) + "\n"
    );
    return;
  }

  // 人话输出
  if (selfResult) {
    if (selfResult.status === "noop") {
      process.stdout.write(
        `✓ tranfu-skills already latest (${selfResult.from})\n`
      );
    } else {
      process.stdout.write(
        `✓ tranfu-skills updated: ${selfResult.from} → ${selfResult.to}\n`
      );
    }
  }

  if (doSkills) {
    const updated = skillResults.filter((r) => r.status === "updated");
    const noop = skillResults.filter((r) => r.status === "noop");
    const orphan = skillResults.filter((r) => r.status === "deleted-upstream");
    const failed = skillResults.filter((r) => r.status === "failed");

    if (skillResults.length === 0) {
      process.stdout.write("No installed skills found.\n");
    } else {
      if (updated.length) {
        process.stdout.write(`Updated ${updated.length} skill(s):\n`);
        for (const r of updated) {
          process.stdout.write(
            `  ${r.name}: ${r.from.slice(0, 7)} → ${r.to.slice(0, 7)} (${r.runtime})\n`
          );
        }
      }
      if (noop.length) {
        process.stdout.write(
          `${noop.length} skill(s) already up-to-date.\n`
        );
      }
      if (orphan.length) {
        process.stdout.write(
          `${orphan.length} skill(s) no longer in remote index (deleted-upstream):\n`
        );
        for (const r of orphan) {
          process.stdout.write(`  ${r.name} (${r.runtime})\n`);
        }
        process.stdout.write(
          "  → Phase 5.4 加 --ack-deletions 静音此 warn; 当前可手动 tfs uninstall.\n"
        );
      }
      if (failed.length) {
        process.stdout.write(`${failed.length} skill(s) failed to update:\n`);
        for (const r of failed) {
          process.stdout.write(`  ${r.name}: ${r.error}\n`);
        }
      }
    }
  }
}
