# 提案：use-agents-for-codex-skills

## 背景
Codex 最新版已把 skills 根目录从 `.codex` 迁移到 `.agents`。`tfs` 仍探测并写入旧目录，导致 Codex 无法发现新安装的 skill。

## 提案
- Codex user scope 从 `~/.codex/skills/` 改为 `~/.agents/skills/`。
- Codex project scope 从 `<git-root>/.codex/skills/` 改为 `<git-root>/.agents/skills/`。
- 同步 runtime 探测、doctor 提示、TTY 文案、README、规格与测试夹具。
- Claude Code 与 Hermes 的路径和行为保持不变。

## 影响
- `src/lib/runtime.ts`、`src/lib/paths.ts`、`src/lib/doctor.ts` 与 `src/commands/install.ts`。
- install lifecycle、doctor 与 catalog 当前事实规格。
- 依赖 Codex 测试目录的测试夹具。
