# 提案：add-hermes-runtime

## 背景
当前 `tfs` 只支持 `claude-code` 与 `codex` 两个 runtime（见 [src/lib/runtime.ts:5-7](../../../src/lib/runtime.ts)）。社区有用户在用 NousResearch 的 **hermes agent**（持久后台 agent，自带 SKILL.md 系统、目录布局与 Claude Code 兼容），它原生支持**多 profile**——每个 profile 是 `~/.hermes/profiles/<name>/` 下一棵独立家目录，含各自的 `skills/`。这些用户目前没法用 `tfs` 把公司库 skill 装到 hermes，更没法精确装到具体某个 profile，只能手动 `git clone` + 拷贝，背离 CLI 的存在意义。

同时 hermes 原生支持**按子目录给 skill 分组**（如 `skills/mlops/<skill>/SKILL.md`、`skills/devops/<skill>/SKILL.md`），让我们有机会把公司库 skill 统一放到 `skills/tranfu/<skill>/` 这一独立分组下，与用户自装、hermes 自带的 skill 物理隔离、视觉清爽。

## 提案
- **加 runtime**：`Runtime` 枚举加 `"hermes"`，探测 `~/.hermes/` 是否存在。
- **升级 scope 模型**：把 `Scope = "user" | "project"` 升级成 discriminated union `Scope = {kind:"user"} | {kind:"project"} | {kind:"profile", name:string}`；CLI `--scope` 接受三种字面值 `user` / `project` / `profile:<name>`。
- **hermes 路径模板**（统一带 `tranfu/` 分组）：
  - `(hermes, user)` → `~/.hermes/skills/tranfu/<skill>/`
  - `(hermes, profile:<name>)` → `~/.hermes/profiles/<name>/skills/tranfu/<skill>/`
  - `(hermes, project)` → 报错（hermes 无 per-cwd 概念）
  - `(claude-code|codex, profile:<name>)` → 报错（非 hermes 不支持 profile）
- **active profile 探测**：新增 `src/lib/hermes.ts`，含 `detectActiveProfile()`（三段 fallback：`$HERMES_HOME` env var → exec `hermes profile list` 解析 active 行 → null 回落到默认 profile）和 `listHermesProfiles()`（`ls ~/.hermes/profiles/`）。未指定 `--scope` 时 `tfs install` 自动调它，输出明示"detected hermes profile: X"。
- **registry 升级**：`installed.json` 主键继续是 `(runtime, scope, name)`，scope 字段序列化为新结构；旧 v1 文件中字符串 scope `"user"`/`"project"` 的 entry MUST lazy migrate 成新结构。
- **doctor 扩展**：runtime check 把 `~/.hermes` 也算；新增 `hermes-profile`（warn）项报告探测到的 active profile + 所有 profile 列表（仅 hermes 存在时输出）。

## 影响
**业务域**：
- [install-lifecycle](../../specs/install-lifecycle/spec.md)（主要）：runtime 枚举、scope 模型、路径解析、registry schema 全部变化；install / uninstall / update / installed / list 命令的 hermes 路径分支。
- [doctor](../../specs/doctor/spec.md)（次要）：runtime check 涵盖 hermes；新增 hermes-profile 检查项；`tfs init` 装 meta-skill 到 hermes 走 active profile。
- [catalog](../../specs/catalog/spec.md)：**零影响**（catalog 与本地 runtime 无关）。

**模块**：
- `src/lib/runtime.ts`、`src/lib/paths.ts`、`src/lib/registry.ts`、`src/lib/doctor.ts` 改。
- **新增** `src/lib/hermes.ts`。
- `src/commands/install.ts` / `uninstall.ts` / `update.ts` / `list.ts` / `installed.ts` / `doctor.ts` / `init.ts` 跟着 scope 类型改。
- `src/cli.ts` 的 `--runtime` / `--scope` 描述串补充新值。

**对外行为**：
- 旧 `--scope user|project` 完全兼容（CLI 字面值不变）；旧 `installed.json` 自动迁移。
- 新增字面值 `--scope profile:<name>`、`--runtime hermes`。
- 旧 `Scope` TypeScript 类型在仓库内部 breaking（项目未发 SDK，无外部消费方，仓库内引用同步改）。
- 新增错误码 `scope_unsupported`（exit 1）。
