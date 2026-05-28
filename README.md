<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/logo-dark.svg">
    <img src="./assets/logo-light.svg" alt="TranFu" width="260">
  </picture>
</p>

# tranfu-skills CLI

[![npm](https://img.shields.io/npm/v/tranfu-skills.svg)](https://www.npmjs.com/package/tranfu-skills)
[![node](https://img.shields.io/node/v/tranfu-skills.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/tranfu-skills.svg)](./LICENSE)

`tranfu-skills` (二进制 `tfs`) 是 [tranfu-labs/tranfu-skills](https://github.com/tranfu-labs/tranfu-skills) skill 库的本地客户端 — 给 Claude Code 与 Codex CLI 提供搜索、安装、升级、卸载、环境诊断五个动作, 取代手动 `git clone` 库再拷贝目录的工作流.

上游库分三类: `meta-skills/` (工作流编排) · `own-skills/` (原创) · `external-skills/` (精选外部引用). 通过 GitHub Release 的 `catalog` tag 分发, 本 CLI 是其唯一的 npm 入口.

## 为什么用它

- **声明式安装**: 一行 `tfs install <name>` 替代 clone → 找目录 → 拷贝 → 校验路径的人肉流程.
- **可观测**: `~/.tfs/installed.json` registry + `tfs doctor` 5 项 check + 6h TTL stale-check, 装哪了 / 哪个 outdated / 是否冲突一眼看清.
- **双 runtime 同一套命令**: Claude Code 与 Codex CLI 共用同一 CLI, user / project 两个安装层级隔离, 不污染全局.
- **agent / 脚本友好**: 所有命令支持 `--json`, 失败统一走 `TfsError` JSON schema, 可被 meta-skill (`tranfu-router`) 直接消费.

## 已支持能力

- [x] `tfs search` — fuzzy 搜远端公司库 (基于 fuse.js)
- [x] `tfs install` / `tfs uninstall` — user / project × Claude Code / Codex 四种组合, frontmatter 戳幂等
- [x] `tfs installed` — 跨 (runtime, scope) 列已装, registry 反向索引
- [x] `tfs catalog` — 列远端公司库全部 skill
- [x] `tfs update` — CLI 自身 + 已装 skill, `--check-only` / `--skills-only` / `--ack-deletions`
- [x] `tfs init` — 一次性 bootstrap meta-skill (`tranfu-router` + `tranfu-publish`)
- [x] `tfs doctor` — Node / runtime / PATH / 旧缓存 / skills-up-to-date 5 项 check
- [x] 全命令 `--json`
- [x] TTY 交互选择 (runtime / scope / 多位置卸载多选) + 落后版本升级 prompt
- [x] `TFS_NO_NAG=1` / `NODE_ENV=test` 全静默

## 适合谁

| 你是 | 看这里 |
|---|---|
| 第一次装 | [Quick start](#quick-start) → `tfs init` |
| 找 / 装 skill | `tfs search` → `tfs install` |
| 看本地装了什么 | `tfs installed` |
| 同步最新版本 | `tfs update` |
| 装出问题 / 想升 CLI | `tfs doctor` / `tfs update --self` |

> 想**发布**新 skill 到公司库走的是 `tranfu-publish` meta-skill (PR-based), 不是本 CLI. 详见公司库的 [PUBLISH.md](https://github.com/tranfu-labs/tranfu-skills/blob/main/PUBLISH.md).

## 安装前提

| 项 | 要求 |
|---|---|
| Node.js | `>=20` |
| 包管理 | `npm` (全局安装) |
| Runtime | Claude Code 或 Codex CLI 至少其一 |
| 网络 | 访问 `api.github.com` (拉 release) + `raw.githubusercontent.com` (拉 skill 内容) |

## Quick start

```bash
npm i -g tranfu-skills

tfs --version          # 验证装好
tfs init               # 探测当前 runtime, 装 tranfu-router + tranfu-publish meta-skill
tfs search 认证         # 搜公司 skill
tfs install <name>     # 装到 user / project (TTY 弹选; 非 TTY 默认 user)
```

`command not found: tfs`?
- fnm / nvm 用户: `fnm use default` 或 `nvm use default`, 让全局 bin 落到默认 node 上.
- 确认 npm 全局 `bin/` 在 `PATH`: `ls "$(npm prefix -g)/bin/tfs"` 应能找到; 找不到则把该路径加进 shell rc.
- 上述都对仍找不到, 再装好后用 `tfs doctor` 排查环境.

## 支持的运行环境

| Runtime | bootstrap | user-level 安装路径 | project-level 安装路径 |
|---|---|---|---|
| Claude Code | `tfs init --runtime claude-code` | `~/.claude/skills/<name>/` | `<cwd>/.claude/skills/<name>/` |
| Codex CLI | `tfs init --runtime codex` | `~/.codex/skills/<name>/` | `<cwd>/.codex/skills/<name>/` |
| 双 runtime | `tfs init --both` | 同上, 两边都装 | — |

未传 `--runtime` 时: 单 runtime 自动探测; 双 runtime + TTY 走交互选择; 非 TTY 抛 `runtime_required`.

## 常用工作流

### 搜 + 装

```bash
tfs search auth                          # top 5
tfs search 认证 --top 10 --json
tfs install <name>                       # 交互选 runtime + scope
tfs install <name> --scope user --runtime claude-code
tfs install <name> --force               # 覆盖已存在的同名目录
```

### 看本地 / 卸载

```bash
tfs installed                            # 跨 runtime + scope 全列
tfs installed --scope project            # 显式 filter
tfs uninstall <name>                     # registry 自动查位置, 多处时交互多选
tfs uninstall <name> --scope user --runtime codex
```

### 升级

```bash
tfs update --check-only                  # 只检测, 不动文件
tfs update                               # CLI 自身 + 已装 skill 都升
tfs update --skills-only                 # 仅升 skill
tfs update --self                        # 仅升 CLI (= npm i -g tranfu-skills@latest)
tfs update --ack-deletions               # 把上游已删的 skill 写入 ack, 静默后续 warn
```

### 诊断

```bash
tfs doctor                               # 5 项 check (Node / runtime / PATH / 旧缓存 / skills-up-to-date)
tfs doctor --json                        # 返 {checks, ok, installed_count, outdated_count}
```

### 给 agent / 脚本消费

- 所有命令: `--json` 走稳定 schema, 失败统一 `{error, message, hint, exit_code}`
- 全静默: `TFS_NO_NAG=1` (关升级 prompt) + `NODE_ENV=test` (关所有交互 / nag)

## 安装产物布局

```
~/.tfs/                                  # CLI 自身状态
├── installed.json                       # registry: name → [(runtime, scope, path)]
├── ack.json                             # 用户已确认的 upstream 删除
└── cache/last-check.json                # stale-check 6h TTL

~/.claude/skills/<name>/SKILL.md         # Claude Code user-level skill
~/.codex/skills/<name>/SKILL.md          # Codex CLI user-level skill
<cwd>/.claude/skills/<name>/SKILL.md     # project-level
<cwd>/.codex/skills/<name>/SKILL.md      # project-level
```

每个由 `tfs` 装的 skill 在其 `SKILL.md` frontmatter 写 `installed_by: tfs` + version 戳, 用于幂等性判定与升级对比. 手动 `git clone` 拷过来的目录无此戳, `tfs` 不会接管.

## CLI 自身发布与维护

- `main` 分支推语义化版本 tag → 自动 publish 到 npm.
- [CHANGELOG.md](./CHANGELOG.md) 是 source of truth, 每个版本附 `Why`.
- CLI 落后远端版本时: TTY 启动弹 prompt 问是否立即升; 非 TTY 走 stderr 提示, 不阻塞.

## 安全边界

- **skill 内容来源**: `tranfu-labs/tranfu-skills` 仓库的 `catalog` tag, 经 CODEOWNER 审核的 PR 才能合入. 本 CLI 不引入 catalog 之外的源.
- **CLI 写盘范围**: 仅 `~/.tfs/`、`~/.{claude,codex}/skills/`、cwd 下 `.{claude,codex}/skills/`. 不动 `PATH` / shell rc / 任何系统位置.
- **CLI 自升**: 走标准 `npm install -g`, 依赖 npm 自身的 tarball 完整性校验.

## License

[MIT](./LICENSE) — 2026 tranfu-labs.
