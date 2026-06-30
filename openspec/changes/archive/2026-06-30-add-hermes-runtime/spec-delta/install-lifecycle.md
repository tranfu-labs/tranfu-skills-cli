# spec-delta：install-lifecycle

> 对 [openspec/specs/install-lifecycle/spec.md](../../../specs/install-lifecycle/spec.md) 的增删改。
> 标记：`~` 修改既有规则、`+` 新增、`-` 删除。归档时合并到 specs。

## 修改 `## 业务规则` → `### Runtime 与 scope 解析`

- ~ Runtime 取值 MUST 是 `claude-code` 或 `codex` **或 `hermes`**；显式 `--runtime` 非这**三**值之一 MUST 抛 `runtime_invalid`（exit 1）。
- ~ `--runtime` 未指定时 MUST 探测 `~/.claude` 与 `~/.codex` **与 `~/.hermes`** 目录是否存在：0 个 → `runtime_required`；1 个 → 静默使用；≥2 个 → `runtime_required`（hint 提示传 `--runtime`，TTY 下 `install` 命令额外走交互选择）。
- ~ Scope 取值 MUST 是 `user` 或 `project` **或 `profile:<name>`**（`profile:<name>` 形式 MUST **仅在 `runtime=hermes` 下接受**）。显式 `--scope` 不是这三种形态之一 MUST 抛 `scope_invalid`（exit 1）；profile 名 MUST 匹配 `^[a-zA-Z0-9_-]+$`，否则也抛 `scope_invalid`。
- + 显式 `--scope profile:<name>` 配 `--runtime claude-code|codex` MUST 抛 `scope_unsupported`（exit 1），hint 指出"profile 仅 hermes 支持"。
- + 显式 `--scope project` 配 `--runtime hermes` MUST 抛 `scope_unsupported`（exit 1），hint 指出"hermes 没有 per-cwd 概念，改用 `--scope user` 或 `--scope profile:<name>`"。
- ~ 目标安装目录的解析 MUST 是：
  - `(claude-code, user)` → `~/.claude/skills/`
  - `(codex, user)` → `~/.codex/skills/`
  - `(claude-code, project)` → `<git-root>/.claude/skills/`
  - `(codex, project)` → `<git-root>/.codex/skills/`
  - **`(hermes, user)` → `~/.hermes/skills/tranfu/`**
  - **`(hermes, profile:<name>)` → `~/.hermes/profiles/<name>/skills/tranfu/`**
- ~ `tfs install` 的 TTY 交互行为 MUST 为：未传 `--runtime` 且探到 ≥2 个 runtime 走 select；**runtime=claude-code 或 codex 时**未传 `--scope` 走 select；非 TTY 时 `--scope` 默认 `user`（零漂移）。
- + `tfs install` 当 `runtime=hermes` 且未传 `--scope` 时 MUST 调 `detectActiveProfile()`：
  - 返回 `<name>` → 用 `{kind:"profile", name:<name>}`，stdout 输出 `· detected hermes profile: <name>`
  - 返回 `null` → 用 `{kind:"user"}`，stdout 输出 `· no active hermes profile, installing to default (~/.hermes/skills/tranfu/)`
- + `detectActiveProfile()` 解析顺序 MUST 是：① 读 `$HERMES_HOME` 环境变量，若匹配 `~/.hermes/profiles/<name>` 路径前缀 → 返 `<name>`；否则 ② 跑 `hermes profile list`，匹配带 `(active)` 标记或开头 `*` 的行，提取 profile 名；命令失败、不存在、输出格式不匹配均视为本段失败；③ 都失败 → 返 `null`。任一阶段抛错 MUST 被吞掉（不让 install 主流程崩）。
- + `listHermesProfiles()` MUST 返回 `~/.hermes/profiles/` 下满足以下条件的目录名：① 不以 `.` 开头；② 是目录（symlink 解引用后也是目录）；③ 匹配 `^[a-zA-Z0-9_-]+$`。`~/.hermes/profiles/` 不存在 MUST 返空数组。

## 修改 `## 业务规则` → `### Registry（~/.tfs/installed.json）`

- ~ 文件 schema 是 `{ version: 1, entries: RegistryEntry[] }`，每条 entry 含 `name / runtime / scope / path / installed_version / installed_at`。**`scope` 字段 MUST 序列化为对象 `{kind: "user"|"project"|"profile", name?: string}`；`kind: "profile"` 的 entry MUST 含 `name`**。
- + `readRegistry` 在解析 entry 时 MUST 做 lazy migrate：若 `scope` 是字符串 `"user"` → 转为 `{kind:"user"}`；`"project"` → `{kind:"project"}`；其他字符串值 MUST 丢弃该 entry（不影响其他 entry）。文件本身的 `version` 字段 MUST 保持 `1`（不 bump）。
- + `bootstrapFromStamps` 在扫描时 MUST 覆盖 hermes 的所有目标位置：`~/.hermes/skills/tranfu/`（→ `scope: {kind:"user"}`）+ `~/.hermes/profiles/<X>/skills/tranfu/` 对每个 `X` ∈ `listHermesProfiles()`（→ `scope: {kind:"profile", name: X}`）。

## 修改 `## 业务规则` → `### Update`

- ~ 升 skill MUST 走 `detectOutdated`：扫**所有 runtime 下所有可达 scope** 已装的有戳 skill（claude-code/codex 仍只扫 user scope；**hermes 同时扫默认 profile 与 `listHermesProfiles()` 列出的所有命名 profile**），与远端 index 比 sha。

## 新增场景（追加到 `## 场景`）

9. **hermes 默认 profile 安装**：`HOME=/tmp/hermes-fake mkdir -p ~/.hermes && tfs install foo --runtime hermes` → `~/.hermes/skills/tranfu/foo/` 出现含戳。
10. **hermes 命名 profile 安装**：`mkdir -p ~/.hermes/profiles/coder && tfs install foo --runtime hermes --scope profile:coder` → `~/.hermes/profiles/coder/skills/tranfu/foo/` 出现。
11. **hermes active profile 自动探测**：`HERMES_HOME=~/.hermes/profiles/work tfs install foo --runtime hermes` → 自动落 work profile，stdout 输出 `· detected hermes profile: work`。
12. **hermes scope 非法组合**：`tfs install foo --runtime hermes --scope project` → `scope_unsupported`；`--runtime claude-code --scope profile:coder` 同样 `scope_unsupported`。
13. **hermes profile 名非法**：`tfs install foo --runtime hermes --scope profile:has\ space` → `scope_invalid`。
14. **registry 迁移**：把已有 `installed.json` 的 entry 改成旧字符串 scope 后跑 `tfs installed` → 输出正常、scope 列显示 `user` / `project` 与 `profile:<name>` 字面值；文件回写后 scope 字段已是对象。
15. **hermes 多 profile update**：同名 skill 装到默认 + coder + work 三处，`tfs update --check-only` 应能扫到三处的 outdated 状态。

## 新增可验证行为（追加到 `## 可验证行为`）

- 新增 `tests/hermes.test.ts` 覆盖 `detectActiveProfile` / `listHermesProfiles` / `PROFILE_NAME_RE`。
- `tests/paths.test.ts` 新增 hermes 三种 scope × 路径模板 + 非法组合断言。
- `tests/registry.test.ts` 新增旧字符串 scope lazy migrate 用例。
- `tests/install.test.ts` / `uninstall.test.ts` / `update.test.ts` / `installed.test.ts` / `doctor.test.ts` 各加 hermes 路径分支。
- 手动验证：跑 `openspec/changes/add-hermes-runtime/tasks.md` 中「AI 验证流程」节的 9 步隔离环境验证。
