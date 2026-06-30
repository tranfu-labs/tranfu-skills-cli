# doctor 规格

## 域定位
本机环境的健康检查（`tfs doctor`）、给新用户的一键 bootstrap（`tfs init` 装 meta-skill）、以及 CLI 自身的版本过期提示（`maybePromptSelfUpgrade`）。这一域**不动远端、不动用户其他 skill**，只关心"用户机器是否准备好跑 tfs"。

## 业务规则

### `tfs doctor` —— 5 项核心检查 + 1 条件项
- **node-version**（fatal）MUST 解析 `process.versions.node` 主版本号：≥ 20 → `ok`；< 20 → `fail`；无法解析 → `fail`。
- **runtime**（fatal）MUST 调 `detectAvailableRuntimes()`：≥1 个 → `ok`；0 个 → `fail`。该探测自然涵盖 hermes（runtime 枚举升级后无需特判）。
- **tfs-in-path**（warn）MUST 跑 `command -v tfs`：找不到 → `warn`；找到但路径前缀不与 `process.execPath` 的 `dirname` 同根 → `warn`（fnm/nvm 切版本场景）；同根 → `ok`。
- **legacy-cache**（warn）MUST 检查 `~/.aistore-labs/claude-skills` / `~/.tranfu-labs/claude-skills` / `~/.tranfu-labs/tranfu-skills` 三个旧路径：任一存在 → `warn`；全无 → `ok`。
- **skills-up-to-date**（warn）MUST 在 `detectOutdatedCached()` 成功时输出：`outdated_count > 0` → `warn`；= 0 → `ok`。stale-check 探测失败（网络挂等）MUST 静默跳过这一项（最终输出 4 项），但 `--json` 仍带 `installed_count: 0, outdated_count: 0`。
- **hermes-profile**（warn，**条件项**）MUST 仅当 `~/.hermes` 存在时追加此项；其他场景该项不出现（保持非 hermes 用户的 doctor 输出干净）。状态：
  - `listHermesProfiles()` 返空 + `~/.hermes/` 本身存在 → `ok`，message 形如 `default profile only (~/.hermes/skills/tranfu/)`
  - `listHermesProfiles()` ≥ 1 → `ok`，message 形如 `active: <X>; all: [a, b, c]`（active 由 `detectActiveProfile()` 给；null 时写 `(default)`）
  - `command -v hermes` 找不到二进制 + `~/.hermes/` 存在 → `warn`，message 形如 `hermes 二进制不在 PATH, detectActiveProfile 第二段 fallback 不可用 — 已用 env / 默认 profile 兜底`
- 任一 `fatal` 检查不 `ok` MUST `exit 1`。仅 `warn` MUST `exit 0` 但人话模式末尾输出 `N warning(s). 不阻塞使用, 但建议处理.`。全绿 MUST 输出 `All checks passed.`。
- `--json` MUST 输出 `{ checks, ok, installed_count, outdated_count }` 单行；`ok=false` 时 MUST `exit 1`。

### `tfs init` —— meta-skill bootstrap
- MUST 先内部调 `runDoctor()`；任一 `fatal` 失败 MUST 抛 `init_precondition_failed`（exit 1），hint 指向 `tfs doctor`。
- Runtime 选择优先级 MUST 是：`--both` > `--runtime` > 单 runtime 自动 > TTY 交互选 > `runtime_required` 报错。`--both` 把所有探到的 runtime 都装一遍（hermes 自然加入此优先级流程，无需特判）。
- 两个 meta-skill MUST 是 `tranfu-router` 和 `tranfu-publish`（硬编码在 `src/commands/init.ts`）。
- 装 meta-skill MUST 走 `downloadSkillToTarget` 到该 runtime 的对应 user scope 目标；**对 hermes runtime，target 由 `detectActiveProfile()` 决定：返回 `<name>` → 装到 `~/.hermes/profiles/<name>/skills/tranfu/`；返回 `null` → 装到 `~/.hermes/skills/tranfu/`**。`installed_source` MUST 为 `meta`。
- 目标已存在 MUST `rmSync` 后重装（幂等），输出 `refreshed`；不存在 → `installed`。
- 任一 meta-skill 不在远端 index 中 MUST 抛 `skill_not_found`（exit 1）。
- 任一下载失败 MUST 抛 `internal_error`（exit 3），hint 给出手动 `tfs install --force` 修补命令。
- 全部成功 MUST 按 runtime 分组输出 `✓ <status> <name>`，末尾追一行 `Restart <Claude Code|Codex CLI|Hermes Agent [+ ...]> 或开新会话 ...`。
- `PRODUCT_NAME` 表 MUST 含 `hermes: "Hermes Agent"`，决定 `tfs init` 末尾的 "Restart ..." 提示文案拼接。

### 自升级提示（`maybePromptSelfUpgrade`，在 `src/cli.ts` 顶层 await）
- MUST 在 TTY 且本地缓存检测到 outdated 时，弹阻塞 prompt 询问用户是否升级；其他场景（非 TTY / 无缓存 outdated 信号 / 显式 `--json` / 显式 `--no-nag`）MUST 改为 fire-and-forget 的 stderr nag 或完全静默。
- 任何失败（fs 错、网络挂、解析坏）MUST 静默吞掉，**绝不抛错、绝不让进程因此非零退出**——hard rule，破坏它会影响所有命令的稳定性。

## 场景
1. **全绿**：Node 22、`~/.claude` 存在、`which tfs` 与 node 同根、无旧缓存、stale-check 0 outdated → 5 项 `✓`，`exit 0`，输出 `All checks passed.`。
2. **Node 太老**：Node 18 → node-version `✗`，exit 1，hint 指向升级 Node。
3. **0 runtime**：未装过 Claude Code / Codex / Hermes Agent → runtime `✗`，exit 1。
4. **stale-check 离线**：上面四项 ok、断网 → `detectOutdatedCached` 用空缓存返空数组（不抛）→ skills-up-to-date 这一项跳过（人话模式 4 项 `✓`，`--json` 仍带 0/0）。
5. **init 阻塞**：`tfs init` 但 doctor 报 Node 18 fatal → 直接 `init_precondition_failed` exit 1，不打远端、不动文件。
6. **init 双 runtime + --both**：探到 `claude-code` 和 `codex`，`tfs init --both` → 两个 meta-skill × 2 runtime = 4 次下载，stdout 4 行 `✓ installed`，重启提示拼成 `Restart Claude Code + Codex CLI ...`。
7. **init 幂等**：紧跟着再跑 `tfs init --both` → 4 行 `✓ refreshed`，路径与之前一致。
8. **自升级静默**：在 CI（非 TTY）跑任何 `tfs` 命令，远端有新版 → 不弹 prompt、不阻塞、最多 stderr 一行 nag（带 `--json` / `--no-nag` 时连 nag 也无）。
9. **hermes runtime check 全绿**：`~/.hermes/` 存在 + Node 22 → runtime ✓ message 形如 `探测到 3 个 runtime: claude-code, codex, hermes`，doctor exit 0。
10. **hermes-profile 默认 only**：`~/.hermes/` 存在但 `~/.hermes/profiles/` 不存在 → hermes-profile ✓ "default profile only"。
11. **hermes-profile 多 profile**：`~/.hermes/profiles/{coder,work}` 存在 + `HERMES_HOME=~/.hermes/profiles/work` → hermes-profile ✓ "active: work; all: [coder, work]"。
12. **hermes 在但二进制不在 PATH**：`~/.hermes/` 存在 + `command -v hermes` 返空 → hermes-profile ⚠ message 解释 fallback 行为，**doctor 主流程仍 exit 0**（仅 warn）。
13. **非 hermes 用户**：`~/.hermes/` 不存在 → hermes-profile **不出现**，doctor 输出回到原 5 项（runtime/node/tfs-in-path/legacy-cache/skills-up-to-date）。
14. **init 到 hermes 默认 profile**：探到 hermes + 无 active → meta-skill 装到 `~/.hermes/skills/tranfu/tranfu-{router,publish}/`，重启提示 "Restart Hermes Agent ..."。
15. **init --both 含 hermes**：探到 3 个 runtime，`tfs init --both` → 装 2 meta × 3 runtime = 6 次，重启提示 "Restart Claude Code + Codex CLI + Hermes Agent ..."。

## 可验证行为
- `npm run test` 中以下文件覆盖本域：
  - `tests/doctor.test.ts`（4 项 check 的所有分支 + JSON 形态 + `_checkHermesProfile` 三态 + 非 hermes 用户不出现该项）
  - `tests/init.test.ts`（precondition 失败、单 runtime、`--both`、幂等、meta-skill 缺失；hermes 装 meta 走 active profile 路径）
  - `tests/self-version-check.test.ts`（TTY/非 TTY、`--json`、`--no-nag`、网络挂均不抛）
  - `tests/stale-check.test.ts`（间接覆盖 skills-up-to-date 数据源；hermes 多 profile 扫描）
- 手动验证：`fnm use 18 && tfs doctor` 应在 node-version `✗` 处 exit 1；`fnm use default && rm -rf ~/.claude ~/.codex ~/.hermes && tfs doctor` 应在 runtime `✗` 处 exit 1；`mkdir -p ~/.hermes && tfs doctor` 应在输出末尾追 hermes-profile 一行。
