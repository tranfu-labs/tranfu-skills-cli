/**
 * doctor: SDK 形态 (供 init 等命令内部调用). 返回结构化结果, 不写 stdout/stderr.
 * CLI 形态 (`tfs doctor` 命令) 在 commands/doctor.ts 调用此 SDK + 人话渲染.
 *
 * Phase 6.1: SDK 骨架 + Node 版本 check.
 * Phase 6.2: CLI 形态包装.
 * Phase 6.3: + runtime 探测 check.
 * Phase 6.4: + PATH 一致性 check (fnm/nvm).
 * Phase 6.5: + 旧 ~/.tranfu-labs 缓存检测.
 */

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

export function runDoctor(): DoctorResult {
  const checks: DoctorCheck[] = [
    _checkNodeVersionFromString(process.versions.node),
    // Phase 6.3+: runtime 探测 / PATH / 旧缓存
  ];
  const ok = checks.every((c) => !c.fatal || c.status === "ok");
  return { checks, ok };
}
