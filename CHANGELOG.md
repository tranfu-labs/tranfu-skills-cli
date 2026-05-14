# Changelog

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
