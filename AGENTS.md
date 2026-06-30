# tranfu-skills · AI 项目操作手册

## 项目概览
公司 Claude / Codex skill 库 CLI（二进制 `tfs`）。给 Claude Code 和 Codex CLI 两个 runtime 提供 skill 的发现 / 安装 / 升级 / 卸载 / 环境诊断五类操作。
栈：Node ≥ 20、TypeScript 5.3（NodeNext ESM、strict）、commander 12 解析参数、fuse.js 7 模糊搜索、tsup 打包、vitest 测试。

## 项目结构
```
src/cli.ts                 CLI 入口, 注册 commander 子命令 + 启动自升级检查
src/commands/              每个文件一个 tfs 子命令的 action: search / install /
                           list / catalog / installed / uninstall / update /
                           doctor / init
src/lib/                   共享库 (commands 依赖、命令间共享):
  runtime.ts               Runtime 枚举 (claude-code / codex / hermes) + 探测 + resolveRuntime
  paths.ts                 Scope discriminated union (user/project/profile:<n>) + resolveTargetPath + parseScope + scopeToString/Equals
  hermes.ts                Hermes profile 探测 (env → exec → null 三段 fallback) + listHermesProfiles + PROFILE_NAME_RE
  registry.ts              ~/.tfs/installed.json 反向索引 + bootstrap from stamps + 旧字符串 scope lazy migrate
  stamp.ts                 SKILL.md frontmatter 戳读写 (intact/partial/absent)
  index-fetch.ts           远端 index.json 抓取 + 5min cache + etag + 软回落
  skill-fetch.ts           单 skill 下载 (staging + atomic rename + rollback)
  stale-check.ts           已装 skill 与远端 sha 比对 (6h cache, hermes 扫所有 profile)
  doctor.ts                诊断 SDK (node/runtime/PATH/legacy-cache + 条件性 hermes-profile)
  match.ts                 fuse.js 子串硬匹配 + fuzzy 排序
  npm.ts                   shell out npm list -g / npm view / npm install -g
  self-version-check.ts    TTY 自升级 prompt (silent fail)
  ack.ts                   ~/.tfs/cache/ack.json deleted-upstream 确认列表
  errors.ts / format.ts    错误 JSON 输出 + 渲染
  prompt.ts                TTY select/multiselect/confirm 交互
src/types.ts               IndexJson / SkillEntry / SkillUpdateResult / TfsError
tests/                     vitest, 一文件一命令对应 src/commands/*
assets/                    README/分发用静态资源 (logo 等)
dist/                      tsup 构建产物 (gitignored, 仅发包时生成)
```

## 常用命令
- 安装依赖：`npm install`
- 构建：`npm run build`（tsup ESM, target node20, --clean）
- 测试：`npm run test`（`vitest run`，一次跑完不 watch）
- Lint / 类型检查：`npm run lint`（`tsc --noEmit`，无 eslint/prettier）
- 本地试跑（构建后）：`node dist/cli.js <args>`，或 `npm link` 后 `tfs <args>`
- 发包前置：`npm run prepublishOnly`（= 重新 build）

## 编码规范
- TypeScript 5.3 严格模式（tsconfig `strict: true`），ESM only（package.json `"type": "module"`）。
- 模块互引用 MUST 带 `.js` 扩展名（NodeNext 解析要求），从 `src/` 内部 import 也如此。
- 错误统一用 `TfsError` 形状（`error / message / hint / exit_code`），lib 层 `throw` 对象、command 层 `emitError` 转 JSON 退出。NEVER 在 lib 里直接写 stdout/stderr。
- 不使用 eslint / prettier。靠 `tsc --noEmit` 把关 + code review 维持风格。
- 提交信息按现有前缀习惯：`feat: ...` / `fix: ...` / `docs: ...` / `doctor: ...` / `release: vX.Y.Z` / `rN slice-M: ...`（非严格 Conventional Commits）。

## 修改前检查
- 读 `docs/architecture/module-map.md` 确认依赖边界。
- 读相关 `openspec/specs/<domain>/spec.md`。
- MUST 确认改动 NEVER 引入 module-map 中被禁的依赖方向；若必须破坏，先写一条 ADR 记录再改。

## 修改后检查
- 跑测试 / lint / 构建，三者全绿（退出码 0）方可提交；任一失败 → 先修复，NEVER 带红提交。
- 更新受影响的 spec 与 ADR。
- 必要时在 `openspec/changes/` 记录变更。

## 禁止事项
- `src/lib/` 内的模块 NEVER 依赖 `src/commands/`（依赖方向只能 commands → lib，反向引入会让命令耦合死、库无法独立测试）。
- `src/commands/` 内的命令 NEVER 互相依赖（共享逻辑下沉到 `src/lib/`；命令之间只能通过 lib 通信）。
- `src/lib/` 内的模块 NEVER 直接 `process.stdout.write` / `process.stderr.write` 用户可见文本（除已有的 `index-fetch.ts` 软回落 warning 这种明确受控点）；用户输出由 commands 层负责，lib 抛 `TfsError` 或返回结构化结果。
- NEVER 提交 `dist/`（已 gitignore）、`node_modules/`、`~/.tfs/` 下任何运行时产物，也 NEVER 提交本机生成的 `index.json`（公司库的 release asset，本仓库不生成、不缓存进 git）。
- 测试 NEVER 真改用户真实 `~/.tfs/` 或 `~/.claude/` / `~/.codex/`；MUST mock `node:os` 的 `homedir`（仓库已有惯例，见 `tests/registry.test.ts` 等）。
- `~/.tfs/cache/` 路径与 `installed.json` schema 是用户机器上的稳定契约，NEVER 在未走 ADR / spec-delta 的前提下改它们的位置或结构。

## 线框图
本项目默认生成 `docs/wireframes/`（字符图线框，用于对齐页面信息架构与版式）。它是**版式事实源**，与 `openspec/specs/`（行为事实源）并列，靠 `openspec/changes/` 流转更新——改页面的 change 在 `changes/<id>/wireframes.md` 画字符图，归档时回流到这里。归档约定见 `openspec/changes/AGENTS.md` 的「归档」一节。
是否保留按下面规则判断：
- 若本项目确定为**无界面**的工具 / 库 / CLI / SDK 类（如纯 npm 工具包），删除整个 `docs/wireframes/` 目录，并删除本节。
- 若有界面，按 `docs/wireframes/AGENTS.md` 的约定，为每个真实路由在 `docs/wireframes/pages/` 下补一页。
