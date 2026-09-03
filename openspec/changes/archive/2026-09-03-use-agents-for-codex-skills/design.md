# 设计：use-agents-for-codex-skills

## 方案
在 runtime 路径映射中把 `codex` 根目录改为 `~/.agents`；project scope 的 Codex 子目录改为 `.agents`。所有扫描、安装、卸载和更新逻辑继续复用现有 `userSkillDir` / `resolveTargetPath`，无需在各命令重复分支。

doctor 与 install 的用户可见路径文案跟随同一映射更新。测试继续用 mock `homedir()` 的隔离目录，并把 Codex fixture 写到 `.agents`。

## 权衡
本次不兼容扫描旧 `.codex` 目录，因为目标是采用 Codex 当前唯一的 skills 路径；同时扫描新旧目录会造成重复安装、歧义卸载和旧目录继续被误认为有效 runtime。

## 风险
- 已经由旧版 `tfs` 安装在 `.codex/skills` 的内容不会被新版自动识别，需要用户按需重新安装到 `.agents/skills`。
- Hermes 在远端 `main` 新增，冲突解决必须保留 `.hermes` 探测与 profile 路径。完整测试、类型检查和构建用于验证该兼容性。
