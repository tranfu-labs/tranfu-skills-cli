# catalog 规格

## 域定位
远端公司 skill 库（`tranfu-labs/tranfu-skills`）的发现：抓 `index.json`、按名称/描述匹配、列全量目录。这一域**只读远端 + 本地缓存**，不动用户的 `~/.claude` / `~/.agents` / `~/.tfs/installed.json` 任何安装目录或 registry。

## 业务规则
- MUST 从 `https://github.com/tranfu-labs/tranfu-skills/releases/latest/download/index.json` 抓取 `index.json`。
- MUST 把抓取结果缓存到 `~/.tfs/cache/index.json`，并把 HTTP `ETag` 写到 `~/.tfs/cache/index.etag`。
- 缓存 TTL MUST 为 5 分钟：本次调用前缓存文件 mtime 距今 `< 5min` 时 MUST 直接返回缓存，**不打网络**。
- TTL 过期时 MUST 发起带 `If-None-Match: <etag>` 的条件请求。HTTP `304` MUST 返回本地缓存。
- HTTP `200` MUST 解析为 `IndexJson` 后覆盖缓存文件并写回新 ETag。解析失败 MUST 抛 `internal_error`（exit 3）。
- HTTP `404` MUST 抛 `index_not_initialized`（exit 1），message 明示"公司库尚未初始化"。
- 网络层失败（DNS / 超时 / 5xx 等）+ 有本地缓存（任意年龄） MUST 软回落：返回缓存内容，并在 stderr 输出 `{"warning":"network_error", ...}` 单行 JSON。
- 网络层失败 + 无本地缓存 MUST 抛 `network_error`（exit 2）。
- `tfs search <query>` MUST 先做大小写不敏感的子串硬匹配（`name` 或 `description` 任一命中），再用 `fuse.js` 对剩余条目做 fuzzy 排序（`name` 权重 2、`description` 权重 1、`threshold: 0.6`），最后取前 `--top N`（默认 5）。
- `tfs search` 的 `--runtime` flag MUST 被接受但忽略——catalog 内容与本地 runtime 无关（保持调用形态与其他命令一致）。
- `tfs catalog` MUST 列出 `index.json` 全部 skill，不分页、不按 runtime 过滤；`--runtime` 同样被接受且忽略。
- 任何 catalog 命令 MUST NOT 写本地安装目录或 `installed.json`。

## 场景
1. **首次抓取**：`~/.tfs/cache/` 不存在，跑 `tfs search foo` → 走网络、`200` 解析成功 → 写 `index.json` + `index.etag` → 子串/fuzzy 匹配后返回前 5 条。
2. **缓存命中**：上次抓取距今 2 分钟，跑 `tfs catalog` → 不打网络，直接读 `~/.tfs/cache/index.json` 列全量。
3. **304 命中**：上次抓取距今 10 分钟（TTL 已过），有 ETag → 发 `If-None-Match`，远端返 `304` → 返回本地缓存。
4. **离线软回落**：上次抓取过、之后断网，跑 `tfs catalog` → `fetch` 抛错 → stderr 写 `warning: network_error` → 仍能从缓存返回结果，exit 0。
5. **冷启动断网**：从未跑过 + 断网 → `fetch` 抛错 + 无缓存 → 抛 `network_error`，exit 2。
6. **公司库未初始化**：远端 release 没有 `index.json` 资产，返 `404` → 抛 `index_not_initialized`，hint 指向"维护者运行 `npm run build:index && git push`"。

## 可验证行为
- `npm run test` 中以下文件覆盖本域行为：
  - `tests/search.test.ts`：子串 / fuzzy 排序 / --top 截断 / 远端忽略
  - `tests/catalog.test.ts`：全量列出 / --json 形态
  - （间接）`tests/registry.test.ts` 中对 fetchIndex mock 的部分
- 手动验证：`rm -rf ~/.tfs/cache && tfs catalog` 首次走网络；立刻再跑应为缓存命中（可在 `~/.tfs/cache/index.json` 看到 mtime 不变）。
