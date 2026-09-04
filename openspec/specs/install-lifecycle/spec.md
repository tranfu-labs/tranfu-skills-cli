# install-lifecycle 规格

## 域定位
把远端 skill 下载到本地某个 `(runtime, scope)` 位置，并维护一份本地 registry（`~/.tfs/installed.json`），支撑后续的列出 / 升级 / 卸载。涵盖 `tfs install` / `tfs uninstall` / `tfs update` / `tfs installed` / `tfs list` 全部生命周期命令。

## 业务规则

### Runtime 与 scope 解析
- Runtime 取值 MUST 是 `claude-code` 或 `codex` 或 `hermes`；显式 `--runtime` 非这三值之一 MUST 抛 `runtime_invalid`（exit 1）。
- `--runtime` 未指定时 MUST 探测 `~/.claude` 与 `~/.agents` 与 `~/.hermes` 目录是否存在：0 个 → `runtime_required`；1 个 → 静默使用；≥2 个 → `runtime_required`（hint 提示传 `--runtime`，TTY 下 `install` 命令额外走交互选择）。
- Scope 取值 MUST 是 `user` 或 `project` 或 `profile:<name>`（`profile:<name>` 形式 MUST 仅在 `runtime=hermes` 下接受）。显式 `--scope` 不是这三种形态之一 MUST 抛 `scope_invalid`（exit 1）；profile 名 MUST 匹配 `^[a-zA-Z0-9_-]+$`，否则也抛 `scope_invalid`。
- 显式 `--scope profile:<name>` 配 `--runtime claude-code|codex` MUST 抛 `scope_unsupported`（exit 1），hint 指出"profile 仅 hermes 支持"。
- 显式 `--scope project` 配 `--runtime hermes` MUST 抛 `scope_unsupported`（exit 1），hint 指出"hermes 没有 per-cwd 概念，改用 `--scope user` 或 `--scope profile:<name>`"。
- `--scope project` MUST 在 git 仓库下运行：通过 `git rev-parse --show-toplevel` 取根；非 git repo MUST 抛 `git_repo_required`（exit 1）。
- 目标安装目录的解析 MUST 是：
  - `(claude-code, user)` → `~/.claude/skills/`
  - `(codex, user)` → `~/.agents/skills/`
  - `(claude-code, project)` → `<git-root>/.claude/skills/`
  - `(codex, project)` → `<git-root>/.agents/skills/`
  - `(hermes, user)` → `~/.hermes/skills/tranfu/`
  - `(hermes, profile:<name>)` → `~/.hermes/profiles/<name>/skills/tranfu/`
- `tfs install` 的 TTY 交互行为 MUST 为：未传 `--runtime` 且探到 ≥2 个 runtime 走 select；**runtime=claude-code 或 codex 时**未传 `--scope` 走 select；非 TTY 时 `--scope` 默认 `user`（零漂移）。
- `tfs install` 当 `runtime=hermes` 且未传 `--scope` 时 MUST 调 `detectActiveProfile()`：
  - 返回 `<name>` → 用 `{kind:"profile", name:<name>}`，stdout 输出 `· detected hermes profile: <name>`
  - 返回 `null` → 用 `{kind:"user"}`，stdout 输出 `· no active hermes profile, installing to default (~/.hermes/skills/tranfu/)`
- `detectActiveProfile()` 解析顺序 MUST 是：① 读 `$HERMES_HOME` 环境变量，若匹配 `~/.hermes/profiles/<name>` 路径前缀 → 返 `<name>`；否则 ② 跑 `hermes profile list`，匹配带 `(active)` 标记或开头 `*` / `>` 的行，提取 profile 名；命令失败、不存在、输出格式不匹配均视为本段失败；③ 都失败 → 返 `null`。任一阶段抛错 MUST 被吞掉（不让 install 主流程崩）。
- `listHermesProfiles()` MUST 返回 `~/.hermes/profiles/` 下满足以下条件的目录名：① 不以 `.` 开头；② 是目录（symlink 解引用后也是目录）；③ 匹配 `^[a-zA-Z0-9_-]+$`。`~/.hermes/profiles/` 不存在 MUST 返空数组。

### 安装幂等与戳判定
- SKILL.md frontmatter 中 `installed_by: tranfu-skills` 加上 `installed_version` / `installed_at` / `installed_source` 四个字段构成"戳"，状态三态：`intact`（四字段齐全）、`partial`（有 `installed_by` 但其余缺/非法）、`absent`（无 `installed_by`）。
- 目标路径不存在 → 直接下载安装。
- 目标路径存在且戳为 `intact` 且 `installed_version === remote.sha` → MUST noop（stdout 输出 `✓ <name> already up-to-date (sha=...)`，exit 0，不重写文件）。
- 目标路径存在且戳为 `intact` 且 sha 不一致 → MUST rm 旧目录后重装（**不需要 `--force`**，这是正常 update 路径）。
- 目标路径存在且戳为 `absent` 或 `partial`，未带 `--force` → MUST 抛 `skill_already_installed`（exit 1），hint 区分两种情况。
- 目标路径存在且戳为 `absent` 或 `partial`，带 `--force` → MUST rm 旧目录后重装。
- 下载 MUST 走 staging + atomic rename：先写到 `<target>/.tfs-staging/<name>/`，所有文件落盘后 `renameSync` 到最终路径；任何步骤失败 MUST `rmSync` staging 目录并抛 `TfsError`（不留半个）。
- 安装成功 MUST 把戳写进 `SKILL.md` 的 frontmatter：`installed_by: tranfu-skills` / `installed_version: <remote sha>` / `installed_at: <ISO date YYYY-MM-DD>` / `installed_source: own|external|meta`。
- 安装成功后 MUST 调 `addEntry` 写一条 registry entry（含 name/runtime/scope/path/installed_version/installed_at）；registry 写失败 MUST 静默降级（不影响安装主功能，下次 `readRegistry` 时由 bootstrap 重建）。
- 安装成功 MUST 输出 `✓ installed <name> to <path>` + `Restart Claude Code|Codex CLI|Hermes Agent ...` 提示（按 runtime 切换产品名）。

### Registry（`~/.tfs/installed.json`）
- 文件 schema 是 `{ version: 1, entries: RegistryEntry[] }`，每条 entry 含 `name / runtime / scope / path / installed_version / installed_at`。**`scope` 字段 MUST 序列化为对象 `{kind: "user"|"project"|"profile", name?: string}`；`kind: "profile"` 的 entry MUST 含 `name`**。
- 文件 MUST 用原子写盘（`<path>.tmp` + `renameSync`）。
- `readRegistry` 在文件缺失或损坏（非 v1 / entries 不是数组）时 MUST bootstrap：扫描所有可达 `(runtime, scope)` 组合的安装目录、读各 `SKILL.md` 戳重建 entries（戳 `absent` 跳过；`partial` 用可得字段填、缺的留空串），并写盘一次。`project` 组合非 git repo 时跳过该组合。覆盖的扫描组合 MUST 包括：
  - `(claude-code, user)` / `(claude-code, project)`
  - `(codex, user)` / `(codex, project)`
  - `(hermes, user)`（→ `~/.hermes/skills/tranfu/`）
  - `(hermes, profile:<n>)` for `<n>` in `listHermesProfiles()`
- `readRegistry` 解析 entry 时 MUST 做 lazy migrate：旧字符串 scope `"user"` → `{kind:"user"}`；`"project"` → `{kind:"project"}`；其他字符串值或不可识别的对象 scope MUST 丢弃该 entry（不影响其他 entry）。文件本身的 `version` 字段 MUST 保持 `1`（不 bump）。检测到迁移 MUST 把规范化后的全量回写一次。
- `readRegistry` MUST lazy prune：path 不存在的 entry 自动剔除；若有剔除 MUST 回写盘一次。
- `addEntry` 对同 `path` 的旧 entry MUST 覆盖（update 重装场景）。
- `removeEntryByPath` 找不到 entry MUST 静默成功（幂等）。

### Uninstall
- 带 `--runtime` 或 `--scope` 的卸载走单 `(runtime, scope)` 路径：MUST 校验 `<target>/<name>/SKILL.md` 存在且戳 ≠ `absent`（即必须是 tranfu-skills 装的），否则抛 `skill_not_found`，hint 提示"手装请手动 rm"。
- 不带任何 flag 的卸载 MUST 从 registry 用 `findByName` 查所有 entry：
  - 0 个 → `skill_not_found`
  - 1 个 → TTY 下 confirm 后删；非 TTY 直删
  - ≥2 个 → TTY 下 multiselect + confirm；非 TTY 抛 `ambiguous_target`，message 列出所有位置（位置渲染含 scope 字面值，profile 写成 `profile:<name>`）

- 卸载操作 MUST 是 `rmSync(recursive, force)` 加 `removeEntryByPath`。

### Update
- `tfs update`（无 flag）= 升 CLI 自身 + 升所有已装 skill。`--self` 仅升 CLI；`--skills-only` 仅升 skill。
- 升 CLI MUST 比较本地 `npm list -g tranfu-skills` 与 `npm view tranfu-skills version`：相同 → noop；不同 → `npm install -g tranfu-skills@latest`。两边都读不到（网络挂或包没发过）MUST 抛 `network_error`（exit 2）而不是盲目 install。
- 升 skill MUST 走 `detectOutdated`：扫**所有 runtime 下所有可达 scope** 已装的有戳 skill（claude-code/codex 仅扫 user scope；hermes 同时扫默认 profile 与 `listHermesProfiles()` 列出的所有命名 profile），与远端 index 比 sha；状态分 `noop` / `outdated` / `deleted-upstream`（远端 index 已无此 skill）/ `deleted-upstream-acked`。每条结果 MUST 携带 `runtime`、`scope` 与 tfs 已解析的最终绝对 `path`（供 update 重装和外部更新前备份定位目标；旧 stale cache entry 可缺省 path）。
- 对 `outdated` 的 skill MUST rm 后重装；对 `deleted-upstream` MUST 保留文件不删，仅在输出里 warn。
- `--check-only` MUST 只读、不 mutate；与 `--self` / `--ack-deletions` 互斥（任一组合 MUST 抛 `invalid_args` exit 1）。`--check-only` 输出 MUST 过滤掉 `noop`，JSON 中每个非 noop 项 MUST 带最终绝对 `path`；实际 update JSON 同样返回 path。
- `--ack-deletions` MUST 把当前所有 `deleted-upstream` 的 name 合并已有 `~/.tfs/cache/ack.json` 写回；写完后这些 skill 在下次 detect 中变成 `deleted-upstream-acked`，人话模式静默（JSON 仍输出）。

### Installed / List 输出
- `tfs installed`（默认）MUST 跨 runtime + scope 全列；`--runtime` / `--scope` 显式收窄过滤（过滤匹配 MUST 按 `scopeEquals` 结构比较，不是字符串比较）。
- 输出 MUST 把 scope 序列化成 CLI 字面值：`user` / `project` / `profile:<name>`。JSON 模式 `installed[].scope` MUST 输出该字面值字符串（外部脚本向后兼容）。
- `tfs list` 现在等价 `tfs installed`（同 action）；`--remote` 为 deprecated alias，行为同 `tfs catalog`。

## 场景
1. **首装**：`tfs install foo --runtime claude-code --scope user` → `~/.claude/skills/foo/` 出现，含 `SKILL.md` 带完整戳；`~/.tfs/installed.json` 多一条 entry。
2. **noop**：紧接着再跑同命令 → stdout `✓ foo already up-to-date`，exit 0，目录 mtime 不变。
3. **正常 update（戳 intact 但 sha 变了）**：远端公司库推了新 sha 后再跑同命令 → 自动覆盖，无需 `--force`。
4. **手装冲突**：用户自己 `git clone` 到 `~/.claude/skills/foo/`（无戳），跑 `tfs install foo` → 抛 `skill_already_installed`；带 `--force` → 删 + 重装并打戳。
5. **跨位置卸载**：同名 skill 装到 `(claude-code, user)` 和 `(codex, user)` 两处，`tfs uninstall foo` 在 TTY 下走 multiselect + confirm；在非 TTY 抛 `ambiguous_target` 列出两处路径。
6. **升级**：远端推新 sha → `tfs update --check-only` 列出 outdated；`tfs update --skills-only` 把所有 outdated rm + 重装。
7. **远端删除**：公司库删了某 skill → `tfs update` 输出 `deleted-upstream` warn；`tfs update --ack-deletions` 后静默。
8. **registry bootstrap**：rm `~/.tfs/installed.json`，跑 `tfs installed` → 自动扫四个目录重建 registry，列出与重建前一致。
9. **hermes 默认 profile 安装**：`HOME=/tmp/hermes-fake mkdir -p ~/.hermes && tfs install foo --runtime hermes` → `~/.hermes/skills/tranfu/foo/` 出现含戳。
10. **hermes 命名 profile 安装**：`mkdir -p ~/.hermes/profiles/coder && tfs install foo --runtime hermes --scope profile:coder` → `~/.hermes/profiles/coder/skills/tranfu/foo/` 出现。
11. **hermes active profile 自动探测**：`HERMES_HOME=~/.hermes/profiles/work tfs install foo --runtime hermes` → 自动落 work profile，stdout 输出 `· detected hermes profile: work`。
12. **hermes scope 非法组合**：`tfs install foo --runtime hermes --scope project` → `scope_unsupported`；`--runtime claude-code --scope profile:coder` 同样 `scope_unsupported`。
13. **hermes profile 名非法**：`tfs install foo --runtime hermes --scope profile:has\ space` → `scope_invalid`。
14. **registry 迁移**：把已有 `installed.json` 的 entry 改成旧字符串 scope 后跑 `tfs installed` → 输出正常、scope 列显示 `user` / `project` 与 `profile:<name>` 字面值；文件回写后 scope 字段已是对象。
15. **hermes 多 profile update**：同名 skill 装到默认 + coder + work 三处，`tfs update --check-only` 应能扫到三处的 outdated 状态。

## 可验证行为
- `npm run test` 中以下文件覆盖本域行为：
  - `tests/install.test.ts` / `tests/install-interactive.test.ts`（含 hermes scope resolver fallback）
  - `tests/uninstall.test.ts` / `tests/uninstall-interactive.test.ts`
  - `tests/update.test.ts`
  - `tests/installed.test.ts` / `tests/list.test.ts`（JSON 模式 scope 字面值兼容）
  - `tests/registry.test.ts`（含 bootstrap、原子写、lazy prune、lazy migrate、hermes 多 profile bootstrap）
  - `tests/paths.test.ts` / `tests/runtime.test.ts`（含 hermes 三种 scope 路径、非法组合、hermes 探测）
  - `tests/hermes.test.ts`（`detectActiveProfile` 三段 fallback、`listHermesProfiles`、`PROFILE_NAME_RE`）
  - `tests/stamp.test.ts`（三态判定 + 写戳保留非戳字段）
  - `tests/stale-check.test.ts`（detectOutdated + 6h 缓存）
  - `tests/ack.test.ts`
- 手动验证：跑一遍上面"场景" 1-15，逐条对照 stdout / exit code / 文件系统状态。
