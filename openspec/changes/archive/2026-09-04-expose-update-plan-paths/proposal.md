# 提案：expose-update-plan-paths

- 状态：Implemented

## 背景
`tfs update --check-only --json` 已能准确决定本轮哪些 Skill 会更新,但结果缺少最终绝对路径。
外部备份器只能退回 `tfs installed --json` 全量枚举,从而访问本轮不会更新的 project 路径并触发 macOS
Documents 权限请求。

## 提案
让 update 检测结果携带本轮目标 `path`,`--check-only --json` 与实际 update JSON 都原样输出该字段。
路径仍由 tfs 的 runtime/scope resolver 生成,外部调用方不需要复制 scope 规则。

## 影响
- `src/lib/stale-check.ts`:检测项带绝对 path。
- `src/commands/update.ts`:JSON 输出 path。
- `src/types.ts`:`SkillUpdateResult.path` 可选字段。
- install-lifecycle spec 与 update 测试。
