import { emitError } from "../lib/errors.js";
import {
  getGlobalVersion,
  getRegistryLatest,
  installGlobalLatest,
} from "../lib/npm.js";

const PKG_NAME = "tranfu-skills";

interface UpdateOpts {
  self?: boolean;
  skillsOnly?: boolean;
  json?: boolean;
}

/**
 * Phase 5.1 范围:
 * - 仅 --self (或默认): 升级 CLI 自身, npm install -g tranfu-skills@latest
 * - --skills-only: 报 not_implemented (Phase 5.2 起实现)
 * - 默认 (无 flag) = --self 行为 (5.2 时改为 self + skills)
 */
export async function updateCommand(opts: UpdateOpts): Promise<void> {
  if (opts.skillsOnly) {
    return emitError({
      error: "not_implemented",
      message: "--skills-only 在 Phase 5.2 起实现",
      hint: "当前仅 tfs update --self (或无 flag, 默认 self) 可用",
      exit_code: 1,
    });
  }

  const fromVersion = getGlobalVersion(PKG_NAME);
  const latestVersion = getRegistryLatest(PKG_NAME);

  // 已是 latest → noop, 不跑 npm install
  if (fromVersion && latestVersion && fromVersion === latestVersion) {
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({
          self: { from: fromVersion, to: fromVersion, status: "noop" },
          skills: [],
        }) + "\n"
      );
    } else {
      process.stdout.write(
        `✓ tranfu-skills already latest (${fromVersion})\n`
      );
    }
    return;
  }

  try {
    installGlobalLatest(PKG_NAME);
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

  // 升级后重新读版本
  const toVersion =
    getGlobalVersion(PKG_NAME) ?? latestVersion ?? "unknown";

  if (opts.json) {
    process.stdout.write(
      JSON.stringify({
        self: { from: fromVersion ?? "unknown", to: toVersion },
        skills: [],
      }) + "\n"
    );
  } else {
    process.stdout.write(
      `✓ tranfu-skills updated: ${fromVersion ?? "unknown"} → ${toVersion}\n`
    );
  }
}
