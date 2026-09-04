# install-lifecycle 规格增量：更新计划路径

## Update

- `detectOutdated` 每条结果必须携带 tfs 按 runtime/scope 解析得到的最终绝对 `path`。
- `tfs update --check-only --json` 的非 noop 项必须输出 `path`;实际 update JSON 同样输出该字段。
- `path` 仅描述该结果对应的本机目标,不改变 scan scope、status 或 mutation 行为。

## 场景

- user/profile scope 中存在 outdated Skill → check-only JSON 对应项含绝对 path,且 path 指向实际更新目录。
- deleted-upstream 项同样含 path,调用方可按 status 决定其不会进入更新备份。
