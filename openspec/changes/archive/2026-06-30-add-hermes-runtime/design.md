# 设计：add-hermes-runtime

## 方案

### 1. Runtime 层（[src/lib/runtime.ts](../../../src/lib/runtime.ts)）
```ts
export type Runtime = "claude-code" | "codex" | "hermes";
export const ALL_RUNTIMES: Runtime[] = ["claude-code", "codex", "hermes"];

const RUNTIME_HOME_DIRS: Record<Runtime, string> = {
  "claude-code": join(homedir(), ".claude"),
  "codex":       join(homedir(), ".codex"),
  "hermes":      join(homedir(), ".hermes"),
};
```
`detectAvailableRuntimes()` 不变（自然遍历新枚举）；`resolveRuntime()` 错误信息中"必须显式指定"的列表跟着扩到 3 个。`userSkillDir(runtime)` 对 hermes 仍返回 `~/.hermes/skills`（**不含** `tranfu/` 分组层；那一层是 path 解析的职责，不是"runtime 根目录"的职责）。

### 2. Scope 层（[src/lib/paths.ts](../../../src/lib/paths.ts)）
```ts
export type Scope =
  | { kind: "user" }
  | { kind: "project" }
  | { kind: "profile"; name: string };

const PROFILE_NAME_RE = /^[a-zA-Z0-9_-]+$/;  // 与 hermes 文档观察到的命名一致

export function parseScopeArg(raw: string | undefined, runtime: Runtime): Scope {
  if (raw === undefined) return { kind: "user" };           // 默认；hermes 由调用方决定要不要走 detectActiveProfile
  if (raw === "user")    return { kind: "user" };
  if (raw === "project") return { kind: "project" };
  if (raw.startsWith("profile:")) {
    const name = raw.slice("profile:".length);
    if (!PROFILE_NAME_RE.test(name)) throw { error: "scope_invalid", ... };
    return { kind: "profile", name };
  }
  throw { error: "scope_invalid", message: `--scope 必须是 user / project / profile:<name>...` };
}

export function resolveTargetPath({ runtime, scope, cwd }) {
  if (runtime === "hermes") {
    if (scope.kind === "project") throw { error: "scope_unsupported", message: "hermes 不支持 --scope project（hermes 没有 per-cwd 概念）", hint: "改 --scope user 或 --scope profile:<name>" };
    if (scope.kind === "user")    return join(homedir(), ".hermes", "skills", "tranfu");
    /* profile */                  return join(homedir(), ".hermes", "profiles", scope.name, "skills", "tranfu");
  }
  // claude-code | codex
  if (scope.kind === "profile") throw { error: "scope_unsupported", message: `${runtime} 不支持 --scope profile:<name>`, hint: "profile 仅 hermes 支持" };
  if (scope.kind === "user")    return userSkillDir(runtime);
  /* project */                  return join(<git-root>, runtime==="claude-code"?".claude":".codex", "skills");
}
```

### 3. 新增 hermes 助手（**新文件** `src/lib/hermes.ts`）
```ts
export function listHermesProfiles(): string[] {
  const dir = join(homedir(), ".hermes", "profiles");
  try {
    return readdirSync(dir).filter(n =>
      !n.startsWith(".") &&
      statSync(join(dir, n)).isDirectory() &&
      PROFILE_NAME_RE.test(n)
    );
  } catch { return []; }
}

export function detectActiveProfile(): string | null {
  // (1) 读 $HERMES_HOME 推断
  const env = process.env.HERMES_HOME;
  if (env) {
    const home = join(homedir(), ".hermes");
    const profilesRoot = join(home, "profiles");
    if (env.startsWith(profilesRoot + sep)) {
      const tail = env.slice(profilesRoot.length + 1).split(sep)[0];
      if (tail && PROFILE_NAME_RE.test(tail)) return tail;
    }
    // env 指向 ~/.hermes 或不可识别 → 落到默认 (null)
  }
  // (2) exec `hermes profile list` 解析 active
  try {
    const out = execSync("hermes profile list 2>/dev/null", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    // 简单解析：找带 active/current/* 标记的行
    const m = out.match(/^[\s*>]*([a-zA-Z0-9_-]+)\s+\(active\)/m)
           ?? out.match(/^\*\s+([a-zA-Z0-9_-]+)/m);
    if (m && PROFILE_NAME_RE.test(m[1]!)) return m[1]!;
  } catch { /* hermes 不在 PATH 或返非零 — silent */ }
  // (3) fallback：null = 默认 profile（等价 scope=user）
  return null;
}
```

### 4. Registry 升级（[src/lib/registry.ts](../../../src/lib/registry.ts)）
- `RegistryEntry.scope: Scope`（新 union 类型）。
- `loadRaw()` 解析时：若 entry 的 `scope` 是字符串 `"user"`/`"project"`，lazy 转 `{kind:"user"|"project"}`；其他字符串值 entry 丢弃（不影响其他 entry）。
- `bootstrapFromStamps()` 在生成 entries 时直接用新结构。
- 持久化时 `JSON.stringify` 自动按新结构序列化；`version: 1` 保持不变（schema 在 entry 级别向后兼容；如未来加更多变化再考虑 bump 到 v2）。

### 5. Install 命令分支（[src/commands/install.ts](../../../src/commands/install.ts)）
- `_resolveScopeInteractive` 改：未指定 scope + runtime=hermes + 任何环境（TTY 或非 TTY）→ 调 `detectActiveProfile()`：
  - 返回 `name` → 用 `{kind:"profile", name}`
  - 返回 `null` → 用 `{kind:"user"}`
  - 并在 stdout 输出 `· detected hermes profile: <name>` 或 `· no active hermes profile, installing to default (~/.hermes/skills/tranfu/)`
- 未指定 scope + runtime=claude-code/codex → 行为不变（TTY select / 非 TTY 默认 user）。
- 显式 `--scope profile:X --runtime claude-code` → 立刻抛 `scope_unsupported`。

### 6. Doctor 扩展（[src/lib/doctor.ts](../../../src/lib/doctor.ts) + [src/commands/doctor.ts](../../../src/commands/doctor.ts)）
- `_checkRuntimeFromList`：扫到 hermes 同样算 `ok`。
- 新增 `_checkHermesProfile`（warn，仅 hermes 在 available 列表里时执行；其他场景该检查项不出现）：
  - `listHermesProfiles().length === 0` + 默认 profile 存在 → ok，message 报 "default profile only"
  - 至少 1 个命名 profile → ok，message 列出"active: X; all: [a, b, c]"
  - hermes 二进制不在 PATH 但 `~/.hermes/` 存在 → warn，message 提示装 hermes CLI 才能用 `detectActiveProfile` 第二段 fallback

### 7. Init 命令（[src/commands/init.ts](../../../src/commands/init.ts)）
- runtime 选择 + `--both` 自然扩到三个 runtime。
- 对 hermes：装 meta-skill 时，target 由 `resolveTargetPath({ runtime: "hermes", scope: detectActiveProfile() ? {kind:"profile",name:...} : {kind:"user"} })` 决定，写到 `~/.hermes/skills/tranfu/<meta-skill>/` 或 `~/.hermes/profiles/<X>/skills/tranfu/<meta-skill>/`。
- 重启提示 PRODUCT_NAME 表加 `"hermes": "Hermes Agent"`。

### 8. CLI 描述串（[src/cli.ts](../../../src/cli.ts)）
- 所有 `--runtime` 描述："claude-code / codex / hermes ..."
- 所有 `--scope` 描述："user / project / profile:&lt;name&gt;（profile 仅 hermes 支持） ..."

## 权衡

### 为什么 scope 用 union 而不是新加 `--profile` flag
**选择**：scope 字面值 `profile:<name>`，主键 arity 不变（`(runtime, scope, name)` 不变）。
**放弃的**：加 `--profile` flag、registry 主键升级成四元组 `(runtime, scope, profile?, name)`。
**理由**：后者改动面更大——所有 list / uninstall / update 命令都得对 profile 维度做穿透；registry 序列化也得加新字段，破坏向后兼容。前者把 hermes 的特异性收在 scope 类型内部，CLI 表面、registry schema 都尽量复用旧的形态。

### 为什么三段 fallback 探测 active profile
**选择**：env var → exec → null。
**放弃的**：单一策略（只读 env，或只调 hermes 命令）。
**理由**：hermes 文档明示 `$HERMES_HOME` 是路径解析的最高优先级——只读它已经覆盖大部分场景。但 sticky default（`hermes profile use X` 后的默认值）只有 hermes 自己知道，所以需要二段 exec 兜底。第三段 null fallback 防止"hermes 不在 PATH" 这种合理场景让 install 失败——回到默认 profile 是安全的。

### 为什么 `tranfu/` 分组层在 path 层而不是 runtime 层
**选择**：分组是 `resolveTargetPath` 拼出来的（hermes 分支独有）。
**放弃的**：`userSkillDir(hermes)` 直接返 `~/.hermes/skills/tranfu`。
**理由**：`userSkillDir` 的语义是"runtime 的 skill 根目录"，hermes 那个根目录 ground truth 就是 `~/.hermes/skills`；分组是公司库这个 *产品* 的约定，不是 hermes 这个 *runtime* 的约定。把它收进 path 层让两件事解耦——以后想给 codex / claude-code 也做分组（如果它们将来支持），改动局部。

### 为什么 `installed.json` 不 bump 到 v2
**选择**：保持 `version: 1`，scope 字段做 entry 级 lazy migrate。
**放弃的**：bump 到 v2，写迁移代码、旧版 CLI 跑新文件直接报 `Unknown version`。
**理由**：scope 字符串 → 对象的迁移是单向、可推断、零信息损失的；旧版 CLI 读新文件中的 `kind:"profile"` entry 会忽略（因为旧代码不认这种 scope），但其他 entry 仍正常工作；用户能"局部回滚"。Bump version 反而把整个文件锁死，伤更大。

## 风险

- **profile 名字符集**：hermes 官方文档没明列 profile 命名约束。先用 `/^[a-zA-Z0-9_-]+$/`，太严会卡边缘用户（如 profile 名带 `.` 或中文），太宽会让 `~/.hermes/profiles/<name>/` 有 path 注入风险（`../`、空格等）。**缓解**：在 `listHermesProfiles` 也用同一正则过滤——若用户真有非法名 profile，CLI 看不到它（safer fail），用户在 stderr 看到的体感是 "这个 profile 没被识别"，可后续放宽。
- **hermes 命令格式漂移**：`hermes profile list` 输出可能换格式。**缓解**：解析失败就当 null（fallback 到默认 profile），不抛错；同时在 `detectActiveProfile` 写注释把当前匹配的输出样例钉死，未来格式变了一眼能改。
- **registry 迁移测试覆盖**：现存 `tests/registry.test.ts` 必须新增旧字符串 scope → 新对象 scope 的迁移用例，否则升级会悄悄丢 entry。**缓解**：单测 `loadRaw()` 时构造混合 entry（部分字符串 scope、部分对象 scope、部分非法值），断言迁移结果。
- **TypeScript breaking on Scope**：仓库内 `Scope` 类型从字符串字面量联合变 union 对象，所有引用点（`paths.ts` / `registry.ts` / `commands/*`）必须同步改。**缓解**：tsc `--noEmit` 全绿才视为完成；测试通过才视为完成。
- **CI 不能真调 hermes**：CI 环境装不了真的 hermes；测试 MUST mock `execSync`、mock fs 的 readdirSync/statSync。**缓解**：现有项目惯例就是 mock `node:os` homedir + mock `node:child_process` execSync，沿用即可。

**回滚**：若发现迁移问题严重，npm 包降到 0.5.x 即可；用户的 `installed.json` 中可能多了 `kind:"profile"` 的 entry，旧版会忽略（不读不写），不会崩，回退干净。
