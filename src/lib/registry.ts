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
import { resolveTargetPath, type Scope, SCOPE_USER, SCOPE_PROJECT } from "./paths.js";
import { listHermesProfiles, PROFILE_NAME_RE } from "./hermes.js";
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

/**
 * 把 entry.scope 标准化成 Scope union 对象.
 * 兼容旧 v1 文件中的字符串值 "user" / "project"; 其他不可识别值 → null (调用方丢弃).
 */
function normalizeScope(raw: unknown): Scope | null {
  if (raw === "user") return SCOPE_USER;
  if (raw === "project") return SCOPE_PROJECT;
  if (raw && typeof raw === "object") {
    const r = raw as { kind?: unknown; name?: unknown };
    if (r.kind === "user") return SCOPE_USER;
    if (r.kind === "project") return SCOPE_PROJECT;
    if (
      r.kind === "profile" &&
      typeof r.name === "string" &&
      PROFILE_NAME_RE.test(r.name)
    ) {
      return { kind: "profile", name: r.name };
    }
  }
  return null;
}

function loadRaw(): RegistryFile | null {
  try {
    const raw = readFileSync(registryPath(), "utf8");
    const parsed = JSON.parse(raw) as RegistryFile;
    if (parsed?.version !== REGISTRY_VERSION || !Array.isArray(parsed.entries)) {
      return null;
    }
    // Lazy migrate: 旧字符串 scope → 对象; 不可识别 scope → 丢弃 entry (silent)
    const migrated: RegistryEntry[] = [];
    for (const e of parsed.entries) {
      const scope = normalizeScope((e as { scope?: unknown }).scope);
      if (scope === null) continue;
      migrated.push({ ...e, scope });
    }
    return { version: REGISTRY_VERSION, entries: migrated };
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
 * 扫所有 (runtime, scope) 组合的目录, 读 stamp, 重建 registry entries.
 *
 * 覆盖:
 *   - claude-code / codex × {user, project}    (project 仅当前 CWD 是 git repo 时扫)
 *   - hermes × user                            (~/.hermes/skills/tranfu/)
 *   - hermes × profile:<n> for n in listHermesProfiles()
 *
 * 仅在 registry 文件首次缺失时调用一次, 之后由 install/uninstall 维护.
 */
function bootstrapFromStamps(): RegistryEntry[] {
  const entries: RegistryEntry[] = [];

  // 构造所有 (runtime, scope) pair
  const pairs: Array<{ runtime: Runtime; scope: Scope }> = [];
  for (const runtime of ALL_RUNTIMES) {
    if (runtime === "hermes") {
      pairs.push({ runtime, scope: SCOPE_USER });
      for (const name of listHermesProfiles()) {
        pairs.push({ runtime, scope: { kind: "profile", name } });
      }
    } else {
      pairs.push({ runtime, scope: SCOPE_USER });
      pairs.push({ runtime, scope: SCOPE_PROJECT });
    }
  }

  for (const { runtime, scope } of pairs) {
    let dir: string;
    try {
      dir = resolveTargetPath({ runtime, scope });
    } catch {
      continue; // project scope 非 git repo, 或 hermes + project (理论不会落到这, 防御性 catch)
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
  return entries;
}

/**
 * 读 registry; 文件缺失 → bootstrap 一次并写盘; 损坏 → 重建.
 * lazy prune: path 不存在的 entry 自动剔除, 若有 prune 则回写.
 * lazy migrate: 旧字符串 scope 在 loadRaw 中已转, 此处只要发现迁移过 (loadRaw 内做了 normalize) 也会回写.
 */
export function readRegistry(): RegistryEntry[] {
  const fileBefore = loadRaw();
  let file = fileBefore;
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

  // 检测是否做过 lazy migrate (loadRaw 输入与 normalize 输出不同时也算迁移)
  let migrated = false;
  if (fileBefore) {
    try {
      const rawText = readFileSync(registryPath(), "utf8");
      const rawJson = JSON.parse(rawText) as RegistryFile;
      if (Array.isArray(rawJson.entries)) {
        for (const e of rawJson.entries) {
          const s = (e as { scope?: unknown }).scope;
          // 旧字符串 scope 或不可识别 scope 都说明需要重写
          if (typeof s === "string") {
            migrated = true;
            break;
          }
          if (s && typeof s === "object" && normalizeScope(s) === null) {
            migrated = true;
            break;
          }
        }
      }
    } catch {
      // 读不到就当没迁移 (后续如果有 prune/missing 仍会回写)
    }
  }

  if (wasMissing || pruned || migrated) {
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
