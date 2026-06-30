import { rmSync } from "node:fs";
import { join } from "node:path";
import { resolveTargetPath, scopeToString, SCOPE_USER } from "../lib/paths.js";
import { downloadSkillToTarget } from "../lib/skill-fetch.js";
import { emitError } from "../lib/errors.js";
import {
  getGlobalVersion,
  getRegistryLatest,
  installGlobalLatest,
} from "../lib/npm.js";
import { readAck, writeAck } from "../lib/ack.js";
import { detectOutdated } from "../lib/stale-check.js";
import { fetchIndex } from "../lib/index-fetch.js";
import type { SkillEntry, SkillUpdateResult, TfsError } from "../types.js";

const PKG_NAME = "tranfu-skills";

interface SelfResult {
  from: string;
  to: string;
  status?: "noop";
}

interface UpdateOpts {
  self?: boolean;
  skillsOnly?: boolean;
  ackDeletions?: boolean;
  json?: boolean;
  checkOnly?: boolean;
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

  // Phase 5.1 B1 fix: 两边都 null → 不盲目 install, 直接报 network_error
  // (registry 不可达 或 包没发过, install 也救不了, 让用户先验环境)
  if (from === null && latest === null) {
    throw {
      error: "network_error",
      message: `无法读取本地 (npm list -g) 或 registry (npm view ${PKG_NAME} version) 的版本`,
      hint:
        "检查 npm 是否可用 (npm --version) + 网络; 或手动跑 npm install -g " +
        PKG_NAME +
        "@latest",
      exit_code: 2,
    };
  }

  if (from && latest && from === latest) {
    return { from, to: from, status: "noop" };
  }

  installGlobalLatest(PKG_NAME); // 抛错由调用方包成 internal_error

  const to = getGlobalVersion(PKG_NAME) ?? latest ?? "unknown";
  return { from: from ?? "unknown", to };
}

async function doSkillsUpdate(): Promise<SkillUpdateResult[]> {
  const detection = await detectOutdated();
  // mutation path 仍需要 indexEntry 拿 path/files/source_url; 二次拉 index (有 disk cache).
  const index = await fetchIndex();
  const results: SkillUpdateResult[] = [];

  for (const r of detection.skills) {
    if (r.status !== "outdated") {
      results.push(r);
      continue;
    }
    // outdated → 重装
    const indexEntry = index.skills.find((s: SkillEntry) => s.name === r.name);
    if (!indexEntry) {
      // 极端 race: detect 后 index 又变了 — 标 failed
      results.push({ ...r, status: "failed", error: "index entry vanished" });
      continue;
    }
    // stale-check 已带回 r.scope (hermes 多 profile 必需); 兼容旧 entry 无 scope 时回落 user
    const scope = r.scope ?? SCOPE_USER;
    let dir: string;
    try {
      dir = resolveTargetPath({ runtime: r.runtime, scope });
    } catch (e) {
      results.push({ ...r, status: "failed", error: String(e) });
      continue;
    }
    const skillDir = join(dir, r.name);
    try {
      rmSync(skillDir, { recursive: true, force: true });
      await downloadSkillToTarget(indexEntry, dir, skillDir, {
        installed_by: "tranfu-skills",
        installed_version: indexEntry.sha,
        installed_at: new Date().toISOString().slice(0, 10),
        installed_source: indexEntry.type,
      });
      results.push({ ...r, status: "updated" });
    } catch (e) {
      results.push({
        ...r,
        status: "failed",
        error: isTfsError(e) ? e.message : String(e),
      });
    }
  }
  return results;
}

export async function updateCommand(opts: UpdateOpts): Promise<void> {
  // --check-only 早出: 仅检测, 不 mutate. 与 --self / --ack-deletions 互斥.
  if (opts.checkOnly) {
    if (opts.self) {
      return emitError({
        error: "invalid_args",
        message: "--check-only 与 --self 互斥 (check-only 不升 CLI)",
        hint: "去掉 --self 或换用 --check-only --skills-only",
        exit_code: 1,
      });
    }
    if (opts.ackDeletions) {
      return emitError({
        error: "invalid_args",
        message: "--check-only 与 --ack-deletions 互斥 (check-only 是只读)",
        hint: "去掉 --ack-deletions 或单跑 tfs update --ack-deletions",
        exit_code: 1,
      });
    }
    let detection: { skills: SkillUpdateResult[]; checked_at: string; cached: boolean };
    try {
      detection = await detectOutdated();
    } catch (e) {
      const underlying = isTfsError(e)
        ? e.message
        : e instanceof Error
        ? e.message
        : String(e);
      return emitError({
        error: "index_fetch_failed",
        message: `读取远端 index 失败: ${underlying}`,
        hint: "检查网络 / GH_TOKEN; 或稍后重试",
        exit_code: 2,
      });
    }
    // 输出层过滤: --check-only 的 skills[] 仅含 outdated / deleted-upstream*; noop 不入数组.
    const filtered = detection.skills.filter((s) => s.status !== "noop");
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({
          self: null,
          skills: filtered,
          checked_at: detection.checked_at,
          cached: detection.cached,
        }) + "\n"
      );
      return;
    }
    // 文本模式
    const outdated = filtered.filter((s) => s.status === "outdated");
    if (outdated.length === 0) return; // 0 outdated → 空 stdout
    process.stdout.write(`发现 ${outdated.length} 个 skill 可更新:\n`);
    for (const s of outdated) {
      const scopeStr = s.scope ? `/${scopeToString(s.scope)}` : "";
      process.stdout.write(
        `  - ${s.name}: ${s.from.slice(0, 7)}..${s.to.slice(0, 7)} (${s.runtime}${scopeStr})\n`
      );
    }
    return;
  }

  // 默认 = both; --self = self only; --skills-only = skills only
  const doSelf = opts.skillsOnly !== true;
  const doSkills = opts.self !== true;

  let selfResult: SelfResult | null = null;
  if (doSelf) {
    try {
      selfResult = await doSelfUpdate();
    } catch (err) {
      // 区分 TfsError (e.g. B1 network_error) vs plain Error (npm install 抛错)
      if (isTfsError(err)) {
        return emitError(err);
      }
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

    // --ack-deletions: 把当前所有 deleted-upstream (含已 acked) 的 name 写入 ack.json
    if (opts.ackDeletions) {
      const toAck = new Set<string>();
      // 保留已 acked
      for (const r of skillResults) {
        if (
          r.status === "deleted-upstream" ||
          r.status === "deleted-upstream-acked"
        ) {
          toAck.add(r.name);
        }
      }
      // 合并已有 ack (防止覆盖以前 ack 但当前 list 没扫到的 — e.g. uninstall 之后)
      const existing = readAck();
      for (const name of existing) toAck.add(name);
      writeAck(toAck);
      // 把新 ack 的 deleted-upstream 状态升级为 deleted-upstream-acked
      for (const r of skillResults) {
        if (r.status === "deleted-upstream") {
          r.status = "deleted-upstream-acked";
        }
      }
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
          ...(r.scope ? { scope: scopeToString(r.scope) } : {}),
          ...(r.error ? { error: r.error } : {}),
        })),
      }) + "\n"
    );
    return;
  }

  // --ack-deletions 跑了, 加一条 stdout 行 (人话模式)
  if (opts.ackDeletions && !opts.json && doSkills) {
    const acked = skillResults.filter(
      (r) => r.status === "deleted-upstream-acked"
    ).length;
    if (acked > 0) {
      process.stdout.write(
        `✓ acked ${acked} deleted-upstream skill(s) (~/.tfs/cache/ack.json).\n`
      );
    }
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
          const scopeStr = r.scope ? `/${scopeToString(r.scope)}` : "";
          process.stdout.write(
            `  ${r.name}: ${r.from.slice(0, 7)} → ${r.to.slice(0, 7)} (${r.runtime}${scopeStr})\n`
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
          const scopeStr = r.scope ? `/${scopeToString(r.scope)}` : "";
          process.stdout.write(`  ${r.name} (${r.runtime}${scopeStr})\n`);
        }
        process.stdout.write(
          "  → tfs update --ack-deletions 静音此 warn (skill 文件保留, 不删).\n"
        );
      }
      // deleted-upstream-acked 在人话模式静默 (JSON 仍输出)
      if (failed.length) {
        process.stdout.write(`${failed.length} skill(s) failed to update:\n`);
        for (const r of failed) {
          process.stdout.write(`  ${r.name}: ${r.error}\n`);
        }
      }
    }
  }
}
