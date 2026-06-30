# Changelog

## 0.6.0 (2026-06-30)

### Added
- 新增 `hermes` runtime — 支持把公司库 skill 装到 NousResearch hermes agent (`~/.hermes/`), 统一放到 `skills/tranfu/<skill>/` 分组下, 与用户自装 / hermes 自带 skill 物理隔离.
- `--scope` 接受新字面值 `profile:<name>`, 配合 `--runtime hermes` 装到指定 profile (`~/.hermes/profiles/<name>/skills/tranfu/<skill>/`). 未指定 scope 时自动探测 active profile (三段 fallback: `$HERMES_HOME` env → `hermes profile list` → 默认 profile), 输出明示 `detected hermes profile: X`.
- `tfs doctor` 新增 `hermes-profile` 检查项 (仅 `~/.hermes/` 存在时显示), 报告 active profile + 全部 profile 列表; runtime check 把 hermes 也计入.
- 新增 `src/lib/hermes.ts` (`detectActiveProfile()` / `listHermesProfiles()`).
- `tfs init` 装 meta-skill 到 hermes 时自动走 active profile.

### Changed
- `tfs doctor`: outdated skill 从末尾一行 hint 提升为独立 check 项 `skills-up-to-date` (warn, non-fatal). outdated > 0 时输出 `⚠ skills-up-to-date: 已装 N 个 skill, M 个 outdated → 跑 \`tfs update\` 同步`, 顺势归到 "N warning(s)" 总数里; outdated = 0 输出 `✓ skills-up-to-date`. stale-check 探测失败时静默跳过该项, 回到 4 项 check (不阻塞 doctor 主流程).
- `--json` 输出: `checks` 数组多一项 `skills-up-to-date` (detection 成功时), `installed_count` / `outdated_count` 字段不变, router skill 现有解析继续可用.
- README 按 readme-optimization playbook 重写, 首屏 logo 居中收宽到 260px, 改用单图 lockup 替代 `<picture>` 双图.
- 内部 `Scope` 类型从字符串联合升级为 discriminated union `{kind:"user"|"project"} | {kind:"profile", name:string}`. `installed.json` 旧字符串 scope entry lazy migrate 成新结构; 外部 CLI 字面值 `user` / `project` 完全兼容, 旧戳 / 旧 registry 文件零迁移成本.

### Errors
- 新增 `scope_unsupported` (exit 1): `(hermes, project)` 和 `(claude-code|codex, profile:*)` 这种非法组合拒绝执行.

### Why
- hermes 用户之前没法用 `tfs` 装公司库 skill, 只能手动 `git clone` + 拷贝. 0.6 让 hermes 成为一等 runtime, 且支持精确装到具体 profile.
- doctor 把 outdated 提为 ⚠ check, 是因为作为末尾 hint 容易被 agent 跳过 — agent 按 INSTALL.md 严格走时看到 4/4 ✓ 会直接停下, 跳过 `tfs update`, 导致老用户的 meta-skill 永远停在装那天的版本.

## 0.5.0 (2026-05-21)

### Added
- TTY 下检测到落后版本时, 弹 interactive prompt 询问是否立即升级 (`y/N`). Y 跑 `npm install -g tranfu-skills@latest` + 提示重跑命令, N 写 `declined_until = now + 24h` 跳过下次 prompt.
- 非 TTY (CI / pipe) 维持 0.4 行为: 仅 stderr nag, 不阻塞.
- `--json` / `TFS_NO_NAG=1` / `NODE_ENV=test` 全部 skip prompt.

### Why
0.4 的 stderr nag 容易被无视, 装了的人不会主动升. 0.5 改成 TTY 下"问一句", 既不打扰 CI / 脚本用户, 又让交互用户一次就能升完.

## 0.4.1 (2026-05-21)

### Fixed
- npm 上的 `0.4.0` 是 broken release: publish 时未重新 build, `dist/cli.js` 是 `0.3.0` 时代的旧 bundle (老 INDEX_URL + 无 `checkSelfVersion`). `0.4.1` 重发正确 dist.
- `package.json` 加 `prepublishOnly: "npm run build"` hook, 防止以后 publish 时漏 build.

`npm i -g tranfu-skills@latest` 即可拿到正确的 `0.4.1`. 已经装了 `0.4.0` 但行为像 `0.3.0` 的用户也升一下.

## 0.4.0 (2026-05-21)

### Breaking
- INDEX_URL 切换到 GitHub Release `catalog` tag. 不再从 `raw.githubusercontent.com/.../main/index.json` 拉.
  - 老版本 (0.3.x) 仍可工作 — 公司库 git 中的 index.json 作为兼容快照保留, 但**不再自动更新**, 老用户看不到 0.4 之后新增的 skill.

### Added
- 启动时自检 npm registry, 落后版本会在 stderr 提示 `tfs update --self`. 24h cache, `TFS_NO_NAG=1` 关掉.

## [0.3.0] - 2026-05-14

跨 location uninstall + TTY 交互 + list 命名重构. 用户 same-day pushback 触发 r2 iteration.

### Added
- `~/.tfs/installed.json` — install registry 反向索引 cache (name → locations). `install` 写, `uninstall` 删, `installed` 读. 首读 bootstrap 从 4 个已知 (runtime, scope) 组合扫 stamp 重建. lazy prune: 读时 path 不存在的 entry 自动剔除并回写.
- `tfs uninstall <name>` 无 flag 时跨 location 查找:
  - 0 处 → `skill_not_found`
  - 1 处 → TTY confirm (y/N) / 非 TTY 直删
  - ≥2 处 → TTY multi-select (1,3 / 1 3 / a / q) + 二次 confirm / 非 TTY `ambiguous_target` 列位置
- `tfs install` 双 runtime + 无 `--runtime` 时 TTY 弹 select; 非 TTY 走原 `runtime_required` throw (零漂移)
- `tfs install` 无 `--scope` 时 TTY 弹 select (user/project); 非 TTY 默认 user (零漂移)
- `tfs catalog` 新命令 — 旧 `tfs list` 行为 (列远端公司库 index)
- `src/lib/registry.ts` — `readRegistry()` / `addEntry()` / `removeEntryByPath()` / `findByName()` / bootstrap 接口
- `src/lib/prompt.ts` — 零依赖 TTY prompts: `selectFromList()` / `multiSelectFromList()` / `confirm()` / `isInteractive()`

### Changed
- `tfs list` 默认行为 — 从 "远端 catalog" 改为 "本地 installed" (与 npm/pip/brew 惯例一致). `--remote` flag 触发 stderr deprecation warning + 转发到 catalog
- `tfs uninstall` hint 文案 — `"跑 tfs list 看已装"` → `"跑 tfs installed 看已装"`
- `tfs installed` 默认 — 从 "单 (runtime, scope)" 改为 "跨所有 (runtime, scope) 通过 registry 列". `--runtime` / `--scope` 作 filter (零漂移显式调用)
- cli.ts: `install` / `installed` / `uninstall` 去掉 `--scope` 默认值 `"user"`, 让 undefined 走交互/registry 路径

### Tests
- 179 → 210 (+31, 0 regression)
- 新增: `tests/registry.test.ts` (8) / `tests/install-interactive.test.ts` (10) / `tests/uninstall-interactive.test.ts` (6) / `tests/catalog.test.ts` (5, 接管旧 list cases)
- 重写: `tests/list.test.ts` (5 → 3 新 case 覆盖 alias + deprecation)
- 扩充: `tests/uninstall.test.ts` (+4 registry-driven cases)

## [0.2.0] - 2026-05-14

无痛更新 + 体验升级. 基于现有功能与角色叠加, 不新增命令, stamp schema 不变.

### Added
- `tfs update --check-only` — 只检测哪些 skill 可更新, 不动文件; 与 `--self` / `--ack-deletions` 互斥
- `tfs doctor --json` — JSON 输出 `{checks, ok, installed_count, outdated_count}`
- 日常命令 piggyback marker: `tfs search` / `tfs installed` / `tfs list` 末尾自动追加 `⚠ N 个 skill 可更新` (有 outdated 时), `--json` 模式顶层加 `stale_hint: {outdated_count, names}` 字段
- `tfs installed` 行尾 ` outdated` 标记 + `--json` 每条加 `outdated: bool`
- `tfs search` 结果行内 `[installed]` / `[installed, outdated]` 标记 + `--json` 每条加 `installed: bool` + `outdated: bool|null`
- `tfs doctor` 末尾汇总行 `已装 N 个 skill, M 个 outdated` (0 outdated 时不带后半)
- `~/.tfs/cache/last-check.json` — 6h TTL cache, 减少 GitHub API 调用; 网络挂时 silent degrade (用 stale cache 或返空, 主命令不崩)
- `src/lib/stale-check.ts` — `detectOutdated()` / `detectOutdatedCached()` / `getStaleHint()` / `staleMarkerLine()` 复用给上述所有 piggyback 路径

### Changed
- `SkillUpdateResult.status` 联合类型新增 `"outdated"` 值 (从 `update.ts` local 上移到 `types.ts` 共享 export)
- `doSkillsUpdate()` 重构: 调 `detectOutdated()` 拿 outdated 候选, mutation 路径仅对 status='outdated' 项跑 rm + download — `tfs update` 默认/`--skills-only` 行为零漂移

### Tests
- 144 → 179 (+35), 0 regression
- 新增: `tests/stale-check.test.ts` (cache hit/miss/expired/网络挂 silent degrade + getStaleHint/staleMarkerLine snapshot lock)
- 扩充: `tests/update.test.ts` (+11 it for `--check-only`) / `tests/installed.test.ts` (+4) / `tests/search.test.ts` (+4) / `tests/doctor.test.ts` (+4)

## [0.1.0] - 2026-05-14

首个正式版本。

### Added
- `tfs search` — 在公司 skill 库中模糊搜索
- `tfs install <skill>` — 安装 skill 到 user / project scope，含 staging + atomic rename + 幂等戳
- `tfs list` — 列已装 / 列远端可用
- `tfs uninstall <skill>` — 卸载已装的公司 skill
- `tfs update` — 升级 CLI 自身 + skill；支持 `--skills-only` / `--ack-deletions` / 上游删除告警
- `tfs init` — 初始化 runtime；支持 Claude Code、Codex CLI、`--both`
- `tfs doctor` — 诊断环境（Node 版本 / SDK / CLI 形态 / 4 个 check）
- 全部命令支持 `--runtime` flag 与 `--json` 输出
- frontmatter 戳 (stamp) 机制用于幂等性管理
