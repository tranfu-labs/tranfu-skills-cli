import { execSync } from "node:child_process";

/**
 * npm helper wrappers — 抽出来便于测试 mock (避免在 unit test 里真跑 npm).
 */

/** 读 globally 安装的某包当前版本, 没装返回 null */
export function getGlobalVersion(pkg: string): string | null {
  try {
    const out = execSync(`npm list -g --depth=0 --json ${pkg}`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    });
    const parsed = JSON.parse(out);
    return parsed?.dependencies?.[pkg]?.version ?? null;
  } catch {
    return null;
  }
}

/** 读 npm registry 上 pkg@latest 版本 */
export function getRegistryLatest(pkg: string): string | null {
  try {
    const out = execSync(`npm view ${pkg} version`, {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "ignore"],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** 跑 npm install -g pkg@latest, 失败抛 Error */
export function installGlobalLatest(pkg: string): void {
  execSync(`npm install -g ${pkg}@latest`, { stdio: "inherit" });
}
