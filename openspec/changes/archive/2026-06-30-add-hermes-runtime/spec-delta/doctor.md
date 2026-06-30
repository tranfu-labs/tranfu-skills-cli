# spec-delta：doctor

> 对 [openspec/specs/doctor/spec.md](../../../specs/doctor/spec.md) 的增删改。
> 标记：`~` 修改既有规则、`+` 新增、`-` 删除。归档时合并到 specs。

## 修改 `## 业务规则` → `### tfs doctor —— 5 项检查`

- ~ **runtime**（fatal）MUST 调 `detectAvailableRuntimes()`：≥1 个 → `ok`；0 个 → `fail`。**该探测自然涵盖 hermes（runtime.ts 枚举升级后无需特判）。**
- + **hermes-profile**（warn）—— **仅当 `~/.hermes` 存在时** 追加此项；其他场景该项不出现（保持非 hermes 用户的 doctor 输出干净）。状态：
  - `listHermesProfiles()` 返空 + `~/.hermes/` 本身存在 → `ok`，message 形如 `default profile only (~/.hermes/skills/tranfu/)`
  - `listHermesProfiles()` ≥ 1 → `ok`，message 形如 `active: <X>; all: [a, b, c]`（active 由 `detectActiveProfile()` 给）
  - `command -v hermes` 找不到二进制 + `~/.hermes/` 存在 → `warn`，message 形如 `hermes 二进制不在 PATH, detectActiveProfile 第二段 fallback 不可用 — 已用 env / 默认 profile 兜底`

## 修改 `## 业务规则` → `### tfs init —— meta-skill bootstrap`

- ~ 装 meta-skill MUST 走 `downloadSkillToTarget` 到该 runtime 的 user scope 目录；**对 hermes runtime，target 由 `detectActiveProfile()` 决定：返回 `<name>` → 装到 `~/.hermes/profiles/<name>/skills/tranfu/`；返回 `null` → 装到 `~/.hermes/skills/tranfu/`**。`installed_source` MUST 为 `meta`。
- ~ Runtime 选择优先级 MUST 是：`--both` > `--runtime` > 单 runtime 自动 > TTY 交互选 > `runtime_required` 报错。`--both` 把所有探到的 runtime 都装一遍。**hermes 自然加入此优先级流程（无需特判）。**
- + `PRODUCT_NAME` 表 MUST 含 `hermes: "Hermes Agent"`，决定 `tfs init` 末尾的 "Restart ..." 提示文案拼接。

## 新增场景（追加到 `## 场景`）

9. **hermes runtime check 全绿**：`~/.hermes/` 存在 + Node 22 → runtime ✓ message 形如 `探测到 3 个 runtime: claude-code, codex, hermes`，doctor exit 0。
10. **hermes-profile 默认 only**：`~/.hermes/` 存在但 `~/.hermes/profiles/` 不存在 → hermes-profile ✓ "default profile only"。
11. **hermes-profile 多 profile**：`~/.hermes/profiles/{coder,work}` 存在 + `HERMES_HOME=~/.hermes/profiles/work` → hermes-profile ✓ "active: work; all: [coder, work]"。
12. **hermes 在但二进制不在 PATH**：`~/.hermes/` 存在 + `command -v hermes` 返空 → hermes-profile ⚠ message 解释 fallback 行为，**doctor 主流程仍 exit 0**（仅 warn）。
13. **非 hermes 用户**：`~/.hermes/` 不存在 → hermes-profile **不出现**，doctor 输出回到原 5 项（runtime/node/tfs-in-path/legacy-cache/skills-up-to-date）。
14. **init 到 hermes 默认 profile**：探到 hermes + 无 active → meta-skill 装到 `~/.hermes/skills/tranfu/tranfu-{router,publish}/`，重启提示 "Restart Hermes Agent ..."。
15. **init --both 含 hermes**：探到 3 个 runtime，`tfs init --both` → 装 2 meta × 3 runtime = 6 次，重启提示 "Restart Claude Code + Codex CLI + Hermes Agent ..."。

## 新增可验证行为（追加到 `## 可验证行为`）

- `tests/doctor.test.ts` 加：hermes runtime 探测 / `_checkHermesProfile` 三态（默认 only / 多 profile / 二进制缺）/ 非 hermes 用户不出现该项。
- `tests/init.test.ts` 加：单 hermes 装 meta；`--both` 含 hermes；hermes detectActiveProfile 返 name 走 profile 路径、返 null 走默认。
- 手动验证：跑 `openspec/changes/add-hermes-runtime/tasks.md` 中「AI 验证流程」第 8 步（`tfs doctor` 输出含 hermes-profile）。
