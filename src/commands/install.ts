import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchIndex } from "../lib/index-fetch.js";
import { resolveRuntime } from "../lib/runtime.js";
import { parseScope, resolveTargetPath } from "../lib/paths.js";
import { writeStamp } from "../lib/stamp.js";
import { emitError } from "../lib/errors.js";
import type { TfsError } from "../types.js";

const RAW_BASE =
  "https://raw.githubusercontent.com/tranfu-labs/tranfu-skills/main";

async function fetchFile(url: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (err) {
    throw {
      error: "network_error",
      message: `无法拉取 ${url}: ${String(err)}`,
      hint: "检查网络连接, 或联系维护者确认 index 服务状态",
      exit_code: 2,
    };
  }
  if (response.status === 404) {
    throw {
      error: "internal_error",
      message: `index 引用的文件不存在 (404): ${url}`,
      hint: "可能 index.json 已过时, 等公司库 CI 重新生成",
      exit_code: 3,
    };
  }
  if (!response.ok) {
    throw {
      error: "network_error",
      message: `拉取文件返回 HTTP ${response.status}: ${url}`,
      hint: "检查网络或稍后重试",
      exit_code: 2,
    };
  }
  return await response.text();
}

export async function installCommand(
  skillName: string,
  opts: { scope?: string; runtime?: string }
): Promise<void> {
  // 1. 解析 runtime / scope / target
  let runtime: ReturnType<typeof resolveRuntime>;
  let target: string;
  try {
    runtime = resolveRuntime(opts.runtime);
    const scope = parseScope(opts.scope);
    target = resolveTargetPath({ runtime, scope });
  } catch (e) {
    return emitError(e as TfsError);
  }

  // 2. fetch index
  let index;
  try {
    index = await fetchIndex();
  } catch (e) {
    return emitError(e as TfsError);
  }

  // 3. 找到 skill
  const skill = index.skills.find((s) => s.name === skillName);
  if (!skill) {
    return emitError({
      error: "skill_not_found",
      message: `skill "${skillName}" 不在公司库 index 中`,
      hint: `跑 tfs search "${skillName}" 看候选`,
      exit_code: 1,
    });
  }

  // 4. target 已存在 → 报 skill_already_installed (Phase 3.1 不做 --force/半残戳/noop, 留给 3.3/3.4/3.5)
  const targetDir = join(target, skillName);
  if (existsSync(targetDir)) {
    return emitError({
      error: "skill_already_installed",
      message: `${targetDir} 已存在`,
      hint:
        "Phase 3.3 起可用 --force 覆盖; 目前请手动 rm 该目录后重试, 或换 --scope",
    exit_code: 1,
    });
  }

  // 5. Phase 3.2: staging + atomic rename
  // 先写到 <target>/.tfs-staging/<skill>/, 全部成功后 renameSync 到 <target>/<skill>/.
  // 任何一步失败 → rmSync 清理 staging, 不留残骸, targetDir 永远不被部分写入.
  const stagingDir = join(target, ".tfs-staging", skillName);
  // 上次失败可能残留 staging, 先清理
  if (existsSync(stagingDir)) {
    rmSync(stagingDir, { recursive: true, force: true });
  }

  try {
    mkdirSync(stagingDir, { recursive: true });
    for (const relFile of skill.files) {
      const url = `${RAW_BASE}/${skill.path}/${relFile}`;
      const content = await fetchFile(url);
      const filePath = join(stagingDir, relFile);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, "utf8");
    }

    // 写 stamp 到 staging 的 SKILL.md (rename 时一起带过去)
    writeStamp(join(stagingDir, "SKILL.md"), {
      installed_by: "tranfu-skills",
      installed_version: skill.sha,
      installed_at: new Date().toISOString().slice(0, 10),
      installed_source: skill.type,
    });

    // atomic rename: staging → target (同文件系统下原子)
    renameSync(stagingDir, targetDir);
  } catch (e) {
    // rollback: 清理 staging
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    return emitError(e as TfsError);
  }

  // 6. 成功输出 (V3 §8.1)
  const restartHint =
    runtime === "claude-code"
      ? "Restart Claude Code or open a new session to load this skill."
      : "Restart Codex CLI or open a new session to load this skill.";
  process.stdout.write(
    `✓ installed ${skillName} to ${targetDir}\n  ${restartHint}\n`
  );
}
