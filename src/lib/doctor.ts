/**
 * doctor: SDK 形态 (供 init 等命令内部调用). 返回结构化结果, 不写 stdout/stderr.
 * CLI 形态 (`tfs doctor` 命令) 在 commands/doctor.ts 调用此 SDK + 人话渲染.
 *
 * Checks (Phase 6.1-6.5 + hermes-profile):
 * - node-version (fatal): Node >=20
 * - runtime (fatal): >=1 个 ~/.claude / ~/.codex / ~/.hermes 存在
 * - tfs-in-path (warn): which tfs 能找到, 且与 process.execPath 同 node 目录
 * - legacy-cache (warn): 检测旧 ~/.aistore-labs / ~/.tranfu-labs 缓存
 * - hermes-profile (warn, 条件性): 仅当 hermes available 时追加, 报告 active + 所有 profile
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { detectAvailableRuntimes, type Runtime } from "./runtime.js";
import { detectActiveProfile, listHermesProfiles } from "./hermes.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  message: string;
  /** fatal=true 的 check status 不 ok → DoctorResult.ok = false, 上层 (init) 应 abort */
  fatal: boolean;
}

export interface DoctorResult {
  checks: DoctorCheck[];
  /** 所有 fatal check 都 ok */
  ok: boolean;
}

const MIN_NODE_MAJOR = 20;

/** Internal: 给 vitest mock 用. 接受版本字符串, 不读 process.versions */
export function _checkNodeVersionFromString(versionStr: string): DoctorCheck {
  const major = parseInt(versionStr.split(".")[0] ?? "0", 10);
  if (isNaN(major)) {
    return {
      name: "node-version",
      status: "fail",
      message: `无法解析 Node 版本: "${versionStr}"`,
      fatal: true,
    };
  }
  if (major >= MIN_NODE_MAJOR) {
    return {
      name: "node-version",
      status: "ok",
      message: `Node ${versionStr} (>= ${MIN_NODE_MAJOR})`,
      fatal: true,
    };
  }
  return {
    name: "node-version",
    status: "fail",
    message: `Node ${versionStr} 太老, 需要 >= ${MIN_NODE_MAJOR}.x. 升级 Node 或用 fnm/nvm 切版本.`,
    fatal: true,
  };
}

/** Internal: runtime check, 接受探测函数注入便于 mock */
export function _checkRuntimeFromList(available: Runtime[]): DoctorCheck {
  if (available.length === 0) {
    return {
      name: "runtime",
      status: "fail",
      message:
        "未检测到任何 runtime (~/.claude, ~/.codex, ~/.hermes 都不存在). 先初始化 Claude Code / Codex CLI / Hermes Agent.",
      fatal: true,
    };
  }
  return {
    name: "runtime",
    status: "ok",
    message: `探测到 ${available.length} 个 runtime: ${available.join(", ")}`,
    fatal: true,
  };
}

/**
 * Internal: hermes-profile check (条件性).
 * 仅当 hermesAvailable=true 时返回 check (其他场景该项不出现, 保持非 hermes 用户 doctor 输出干净).
 * 入参纯数据, 便于测试.
 */
export function _checkHermesProfile(
  hermesAvailable: boolean,
  whichHermesOutput: string | null,
  profiles: string[],
  active: string | null
): DoctorCheck | null {
  if (!hermesAvailable) return null;
  if (!whichHermesOutput) {
    return {
      name: "hermes-profile",
      status: "warn",
      message:
        "hermes 二进制不在 PATH, detectActiveProfile 第二段 fallback 不可用 — 已用 env / 默认 profile 兜底",
      fatal: false,
    };
  }
  if (profiles.length === 0) {
    return {
      name: "hermes-profile",
      status: "ok",
      message: "default profile only (~/.hermes/skills/tranfu/)",
      fatal: false,
    };
  }
  const activeLabel = active ?? "(default)";
  return {
    name: "hermes-profile",
    status: "ok",
    message: `active: ${activeLabel}; all: [${profiles.join(", ")}]`,
    fatal: false,
  };
}

/** Internal: tfs PATH check, 接受 which 输出 + node 路径 */
export function _checkTfsInPath(
  whichTfsOutput: string | null,
  nodeExecPath: string
): DoctorCheck {
  if (!whichTfsOutput) {
    return {
      name: "tfs-in-path",
      status: "warn",
      message:
        "tfs 不在 PATH (可能还没 npm install -g, 或 fnm/nvm 切换了 Node 后没 use default)",
      fatal: false,
    };
  }
  // fnm/nvm 一致性: tfs 路径应在当前 node 的同目录或近邻 bin
  // 简化: 检查 tfs 路径是否与 nodeExecPath 共享一段 ancestor (e.g. 同一 .fnm/versions 子树)
  const nodeBinDir = nodeExecPath.replace(/\/node$/, "");
  if (whichTfsOutput.startsWith(nodeBinDir)) {
    return {
      name: "tfs-in-path",
      status: "ok",
      message: `tfs at ${whichTfsOutput}`,
      fatal: false,
    };
  }
  // 路径不一致 — 可能 fnm 切版本了
  return {
    name: "tfs-in-path",
    status: "warn",
    message: `tfs 在 ${whichTfsOutput}, 但当前 Node 在 ${nodeExecPath}. fnm/nvm 切版本可能让 tfs 不可达, 建议 fnm use default.`,
    fatal: false,
  };
}

/** Internal: 旧缓存 check, 接受路径数组 */
export function _checkLegacyCachePaths(found: string[]): DoctorCheck {
  if (found.length === 0) {
    return {
      name: "legacy-cache",
      status: "ok",
      message: "无旧版 git-clone 缓存",
      fatal: false,
    };
  }
  return {
    name: "legacy-cache",
    status: "warn",
    message: `检测到旧版缓存: ${found.join(", ")}. 新版 tfs 不依赖, 可手动 rm 清理.`,
    fatal: false,
  };
}

const LEGACY_CACHE_PATHS = [
  ".aistore-labs/claude-skills",
  ".tranfu-labs/claude-skills",
  ".tranfu-labs/tranfu-skills",
];

function tryWhichTfs(): string | null {
  try {
    const out = execSync("command -v tfs 2>/dev/null", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function tryWhichHermes(): string | null {
  try {
    const out = execSync("command -v hermes 2>/dev/null", {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

export function runDoctor(): DoctorResult {
  const found = LEGACY_CACHE_PATHS
    .map((p) => join(homedir(), p))
    .filter(existsSync);
  const available = detectAvailableRuntimes();
  const hermesAvailable = available.includes("hermes");

  const checks: DoctorCheck[] = [
    _checkNodeVersionFromString(process.versions.node),
    _checkRuntimeFromList(available),
    _checkTfsInPath(tryWhichTfs(), process.execPath),
    _checkLegacyCachePaths(found),
  ];

  // hermes-profile check 条件性追加, 仅 hermes available 时
  if (hermesAvailable) {
    const profileCheck = _checkHermesProfile(
      true,
      tryWhichHermes(),
      listHermesProfiles(),
      detectActiveProfile()
    );
    if (profileCheck) checks.push(profileCheck);
  }

  const ok = checks.every((c) => !c.fatal || c.status === "ok");
  return { checks, ok };
}
