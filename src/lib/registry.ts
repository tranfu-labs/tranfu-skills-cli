import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Runtime } from "./runtime.js";
import { ALL_RUNTIMES } from "./runtime.js";
import { ALL_SCOPES, resolveTargetPath, type Scope } from "./paths.js";
import { readStamp } from "./stamp.js";

const REGISTRY_VERSION = 1;
const REGISTRY_FILE = "installed.json";

export interface RegistryEntry {
  name: string;
  runtime: Runtime;
  scope: Scope;
  path: string;
  installed_version: string;
  installed_at: string;
}

interface RegistryFile {
  version: number;
  entries: RegistryEntry[];
}

function registryPath(): string {
  return join(homedir(), ".tfs", REGISTRY_FILE);
}

function registryDir(): string {
  return join(homedir(), ".tfs");
}

function loadRaw(): RegistryFile | null {
  try {
    const raw = readFileSync(registryPath(), "utf8");
    const parsed = JSON.parse(raw) as RegistryFile;
    if (parsed?.version !== REGISTRY_VERSION || !Array.isArray(parsed.entries)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function persist(file: RegistryFile): void {
  const dir = registryDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = registryPath() + ".tmp";
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", "utf8");
  renameSync(tmp, registryPath());
}

/**
 * 扫 4 个已知 (runtime, scope) 组合的目录, 读 stamp, 重建 registry entries.
 * project scope 仅扫 CWD 的 git-root (无法跨工作目录).
 * 仅在 registry 文件首次缺失时调用一次, 之后由 install/uninstall 维护.
 */
function bootstrapFromStamps(): RegistryEntry[] {
  const entries: RegistryEntry[] = [];
  for (const runtime of ALL_RUNTIMES) {
    for (const scope of ALL_SCOPES) {
      let dir: string;
      try {
        dir = resolveTargetPath({ runtime, scope });
      } catch {
        continue; // project scope 非 git repo, 跳过
      }
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue; // 目录不存在
      }
      for (const name of names) {
        if (name.startsWith(".")) continue;
        const skillDir = join(dir, name);
        try {
          if (!statSync(skillDir).isDirectory()) continue;
        } catch {
          continue;
        }
        const stamp = readStamp(join(skillDir, "SKILL.md"));
        if (stamp.status === "absent") continue;
        const installed_version =
          stamp.status === "intact"
            ? stamp.data.installed_version
            : stamp.partial.installed_version ?? "";
        const installed_at =
          stamp.status === "intact"
            ? stamp.data.installed_at
            : stamp.partial.installed_at ?? "";
        entries.push({
          name,
          runtime,
          scope,
          path: skillDir,
          installed_version,
          installed_at,
        });
      }
    }
  }
  return entries;
}

/**
 * 读 registry; 文件缺失 → bootstrap 一次并写盘; 损坏 → 重建.
 * lazy prune: path 不存在的 entry 自动剔除, 若有 prune 则回写.
 */
export function readRegistry(): RegistryEntry[] {
  let file = loadRaw();
  let wasMissing = false;
  if (!file) {
    wasMissing = true;
    file = { version: REGISTRY_VERSION, entries: bootstrapFromStamps() };
  }
  const live: RegistryEntry[] = [];
  let pruned = false;
  for (const e of file.entries) {
    if (existsSync(e.path)) {
      live.push(e);
    } else {
      pruned = true;
    }
  }
  if (wasMissing || pruned) {
    persist({ version: REGISTRY_VERSION, entries: live });
  }
  return live;
}

/** 加一条 entry (同 path 已存在则覆盖, 例如 update 重装). 写盘原子. */
export function addEntry(entry: RegistryEntry): void {
  const entries = readRegistry();
  const next = entries.filter((e) => e.path !== entry.path);
  next.push(entry);
  persist({ version: REGISTRY_VERSION, entries: next });
}

/** 按 path 删一条 entry. 找不到不报错 (幂等). */
export function removeEntryByPath(path: string): void {
  const entries = readRegistry();
  const next = entries.filter((e) => e.path !== path);
  if (next.length === entries.length) return;
  persist({ version: REGISTRY_VERSION, entries: next });
}

/** 按 name 查所有 entry (可能跨多 scope/runtime). */
export function findByName(name: string): RegistryEntry[] {
  return readRegistry().filter((e) => e.name === name);
}
