# 任务：add-hermes-runtime

## lib 层
- [ ] [src/lib/runtime.ts](../../../src/lib/runtime.ts)：`Runtime` 加 `"hermes"`、`ALL_RUNTIMES` 加之、`RUNTIME_HOME_DIRS` 加 `~/.hermes`、`resolveRuntime` 错误信息扩到 3 个 runtime
- [ ] [src/lib/paths.ts](../../../src/lib/paths.ts)：`Scope` 升级成 discriminated union；新增 `parseScopeArg(raw, runtime)` 替代 `parseScope`；`resolveTargetPath` 加 hermes 分支（含 `tranfu/` 分组）；非 hermes + profile / hermes + project 抛 `scope_unsupported`
- [ ] **新增** `src/lib/hermes.ts`：`listHermesProfiles()` / `detectActiveProfile()`（三段 fallback）/ 共享 `PROFILE_NAME_RE`
- [ ] [src/lib/registry.ts](../../../src/lib/registry.ts)：`RegistryEntry.scope` 改为 `Scope` 新类型；`loadRaw` 加旧字符串 → 对象 lazy migrate；`bootstrapFromStamps` 用新 scope 形态；持久化按新结构序列化
- [ ] [src/lib/doctor.ts](../../../src/lib/doctor.ts)：`_checkRuntimeFromList` 自然含 hermes（无需特判）；**新增** `_checkHermesProfile`（warn，仅 hermes available 时输出）

## commands 层
- [ ] [src/commands/install.ts](../../../src/commands/install.ts)：`_resolveScopeInteractive` 处理 hermes 默认走 `detectActiveProfile`；输出明示探测结果；显式非法组合（claude-code + profile）走新错误码
- [ ] [src/commands/uninstall.ts](../../../src/commands/uninstall.ts)：跟着 `parseScopeArg` 改；`ambiguous_target` 输出能显示 profile 后缀
- [ ] [src/commands/update.ts](../../../src/commands/update.ts) + [src/lib/stale-check.ts](../../../src/lib/stale-check.ts)：scan loop 把 hermes 三种 scope 都覆盖（默认 profile + 所有命名 profile），不再硬编码 `scope: "user"`
- [ ] [src/commands/list.ts](../../../src/commands/list.ts) / [installed.ts](../../../src/commands/installed.ts)：scope 字段渲染按 union 展开（`profile:<name>` 字面值）
- [ ] [src/commands/doctor.ts](../../../src/commands/doctor.ts)：拼上 `_checkHermesProfile` 结果（仅 hermes available 时追加）
- [ ] [src/commands/init.ts](../../../src/commands/init.ts)：hermes 装 meta-skill 走 `detectActiveProfile` 决定 target；`PRODUCT_NAME` 加 hermes
- [ ] [src/cli.ts](../../../src/cli.ts)：所有 `--runtime` / `--scope` 描述串扩到新值

## 测试层（按测试门槛——大量可测逻辑，全部必须）
- [ ] [tests/runtime.test.ts](../../../tests/runtime.test.ts)：hermes 加入枚举 / 探测 / resolveRuntime
- [ ] [tests/paths.test.ts](../../../tests/paths.test.ts)：6 个新分支（user/profile/project × hermes/非hermes）+ `parseScopeArg` 所有合法非法字面值
- [ ] **新增** `tests/hermes.test.ts`：`detectActiveProfile` 三段 fallback、`listHermesProfiles` mock fs、`PROFILE_NAME_RE` 边界（带 `../`、空字符串、合法名）
- [ ] [tests/registry.test.ts](../../../tests/registry.test.ts)：旧字符串 scope → 对象的 lazy migrate；混合 entry；非法值丢弃；`bootstrapFromStamps` 在 hermes 默认 + profile 目录都能扫到
- [ ] [tests/install.test.ts](../../../tests/install.test.ts) + interactive：hermes user / profile 路径正确、`--scope profile:bad name` 报 `scope_invalid`、claude-code + profile 报 `scope_unsupported`
- [ ] [tests/uninstall.test.ts](../../../tests/uninstall.test.ts) + interactive：hermes 多 profile 装同名 skill 的 ambiguous_target / multiselect
- [ ] [tests/update.test.ts](../../../tests/update.test.ts) + [stale-check.test.ts](../../../tests/stale-check.test.ts)：hermes 多 profile 都被扫到、outdated 计数正确
- [ ] [tests/installed.test.ts](../../../tests/installed.test.ts) / [list.test.ts](../../../tests/list.test.ts)：scope 字段渲染 `profile:<name>` 字面值；--scope 过滤命中
- [ ] [tests/doctor.test.ts](../../../tests/doctor.test.ts)：hermes runtime ok、hermes-profile 三态（无 profile、有命名 profile、hermes 不在 PATH）

## AI 验证流程（agent 在隔离 HOME 跑、对照输出）
- [ ] 准备：`HOME=/tmp/hermes-fake mkdir -p ~/.hermes/profiles/{coder,work}`
- [ ] `tfs install <skill> --runtime hermes` → `~/.hermes/skills/tranfu/<skill>/SKILL.md` 存在、戳 `installed_source: own`
- [ ] `tfs install <skill> --runtime hermes --scope profile:coder` → `~/.hermes/profiles/coder/skills/tranfu/<skill>/` 存在
- [ ] `HERMES_HOME=~/.hermes/profiles/work tfs install <skill> --runtime hermes` → 自动落 work；stdout 含 "detected hermes profile: work"
- [ ] `tfs install <skill> --runtime hermes --scope project` → exit ≠ 0，stderr JSON 含 `scope_unsupported`
- [ ] `tfs install <skill> --runtime claude-code --scope profile:coder` → exit ≠ 0，stderr JSON 含 `scope_unsupported`
- [ ] `tfs installed --runtime hermes` → 三条 entry，scope 字段分别 `user` / `profile:coder` / `profile:work`
- [ ] `tfs uninstall <skill> --runtime hermes --scope profile:coder` → coder 消失，其余两份在
- [ ] `tfs doctor` → hermes runtime ✓、hermes-profile 项列 active + 所有 profile
- [ ] **回归**：`tfs install x --runtime claude-code --scope user` 和 `--runtime codex --scope project` 行为不变

## 完成判据
- `npm run lint` 全绿（tsc --noEmit 0 错误）
- `npm run test` 全绿（vitest 含上述所有新增 + 回归）
- 上面 AI 验证流程逐条通过
