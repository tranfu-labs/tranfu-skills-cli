import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeStamp, type StampData } from "./stamp.js";
import type { SkillEntry } from "../types.js";

const RAW_BASE =
  "https://raw.githubusercontent.com/tranfu-labs/tranfu-skills/main";

/** 拉单文件 raw content. 失败 throw TfsError 对象 */
export async function fetchFile(url: string): Promise<string> {
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

/**
 * 把 skill 完整下载到 targetDir.
 * - 写 staging → atomic rename
 * - 任何步骤失败 → rmSync staging + throw
 * - 调用方负责 targetDir 已存在的处理 (rm 或冲突 emit)
 *
 * 注意: 不调 emitError. 失败抛 TfsError 对象 (或原生 Error 给上层 catch 包成 internal_error).
 */
export async function downloadSkillToTarget(
  skill: SkillEntry,
  targetParent: string,
  targetDir: string,
  stamp: StampData
): Promise<void> {
  const stagingDir = join(targetParent, ".tfs-staging", skill.name);
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
    writeStamp(join(stagingDir, "SKILL.md"), stamp);
    renameSync(stagingDir, targetDir);
  } catch (err) {
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  }
}
