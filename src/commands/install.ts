import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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

  // 5. mkdir + 拉每个文件 + 写盘 (Phase 3.1 不 staging, 失败留残骸, 3.2 加 atomic)
  try {
    mkdirSync(targetDir, { recursive: true });
    for (const relFile of skill.files) {
      const url = `${RAW_BASE}/${skill.path}/${relFile}`;
      const content = await fetchFile(url);
      const filePath = join(targetDir, relFile);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, "utf8");
    }
  } catch (e) {
    return emitError(e as TfsError);
  }

  // 6. 写 stamp 到 SKILL.md (writeStamp 会保留原 frontmatter + 加 installed_* 字段)
  const skillMdPath = join(targetDir, "SKILL.md");
  writeStamp(skillMdPath, {
    installed_by: "tranfu-skills",
    installed_version: skill.sha,
    installed_at: new Date().toISOString().slice(0, 10), // YYYY-MM-DD
    installed_source: skill.type,
  });

  // 7. 成功输出 (V3 §8.1)
  const restartHint =
    runtime === "claude-code"
      ? "Restart Claude Code or open a new session to load this skill."
      : "Restart Codex CLI or open a new session to load this skill.";
  process.stdout.write(
    `✓ installed ${skillName} to ${targetDir}\n  ${restartHint}\n`
  );
}
