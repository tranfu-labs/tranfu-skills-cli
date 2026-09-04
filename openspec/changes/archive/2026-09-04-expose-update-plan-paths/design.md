# 设计：expose-update-plan-paths

## 方案
`detectOutdated()` 已在每个扫描项上计算 `skillDir`;把它作为 `path` 放入所有状态结果。update 命令 JSON
序列化增加可选 `path`,不改变文本输出、扫描范围、过滤规则或更新行为。

外部调用方使用 `status === "outdated"` 的 path 作为更新前备份目标;`deleted-upstream` 虽有 path,但不会更新。

## 权衡
不新增独立 plan 子命令,复用既有 `--check-only` 语义。相比让调用方从 runtime/scope 推导路径,由 tfs 输出
已解析路径可保持单一事实源。

## 风险
JSON 新增字段为向后兼容扩展。path 是本机命令输出,不会上传。回滚只需停止输出该可选字段。
