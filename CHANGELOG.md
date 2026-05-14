# Changelog

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
