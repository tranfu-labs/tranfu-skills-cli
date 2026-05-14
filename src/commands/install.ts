import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fetchIndex } from "../lib/index-fetch.js";
import { resolveRuntime } from "../lib/runtime.js";
import { parseScope, resolveTargetPath } from "../lib/paths.js";
import { readStamp, writeStamp } from "../lib/stamp.js";
import { emitError } from "../lib/errors.js";
import type { TfsError } from "../types.js";

/** Type guard: 区分 lib throw 的 TfsError 与 fs/network 原生 Error */
function isTfsError(e: unknown): e is TfsError {
  return (
    typeof e === "object" &&
    e !== null &&
    "error" in e &&
    "message" in e &&
    "exit_code" in e
  );
}

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
  opts: { scope?: string; runtime?: string; force?: boolean }
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

  // 4. target 已存在 → 读戳判断行为
  //    Phase 3.3 scope: 无戳 + --force → rm + 继续; 其他都 skill_already_installed
  //    Phase 3.4/3.5 留: partial stamp / intact stamp 的 update / noop 路径
  const targetDir = join(target, skillName);
  if (existsSync(targetDir)) {
    const stamp = readStamp(join(targetDir, "SKILL.md"));
    // Phase 3.3: absent + --force 覆盖
    // Phase 3.4: partial + --force 覆盖 (半残戳视为损坏, --force 重写)
    // Phase 3.5 留: intact + sha 一致 noop / sha 不一致直接覆盖
    if ((stamp.status === "absent" || stamp.status === "partial") && opts.force) {
      rmSync(targetDir, { recursive: true, force: true });
    } else {
      const hint =
        stamp.status === "absent"
          ? "用 --force 覆盖 (会先 rm 该目录, 销毁性). Phase 3.5 起 intact 戳走 noop/update."
          : stamp.status === "partial"
            ? "检测到不完整的安装戳 (缺 installed_version 等). 用 --force 重写它 (rm 旧目录 + 重装)."
            : "已是 tranfu-skills 装过的完整 skill; Phase 3.5 起 sha 一致走 noop, 不一致走 update. 当前请手动 rm.";
      return emitError({
        error: "skill_already_installed",
        message: `${targetDir} 已存在 (stamp: ${stamp.status})`,
        hint,
        exit_code: 1,
      });
    }
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
    // 区分 TfsError vs 原生 Error (e.g. renameSync EXDEV / EPERM)
    if (isTfsError(e)) {
      return emitError(e);
    }
    return emitError({
      error: "internal_error",
      message: `install 内部错误: ${e instanceof Error ? e.message : String(e)}`,
      hint: "可能是文件系统问题 (跨分区 rename / 权限). 请报 issue.",
      exit_code: 3,
    });
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
