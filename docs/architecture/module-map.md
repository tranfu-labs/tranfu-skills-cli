# 模块地图

> 顶层源码按目录分两个模块：`src/lib`（共享库）与 `src/commands`（CLI 子命令处理器）。
> `src/cli.ts` 是入口（不算模块），只做 commander 路由 + 把子命令挂到 `tfs` 二进制下。

### src/lib
- 职责边界：提供运行时探测、路径解析、网络抓取、本地 registry/stamp 维护、错误对象、TTY 交互等无副作用或受控副作用的工具，给 `src/commands` 复用。MUST 用结构化错误（throw `TfsError` 对象）或返回值表达失败，**不直接写 stdout/stderr**（已有的 `index-fetch.ts` 网络软回落 warning 是受控例外）。
- 入口：每个 `src/lib/<name>.ts` 都是命名导出，无 default。关键导出包括 `resolveRuntime` / `detectAvailableRuntimes` / `userSkillDir`（runtime.ts）、`resolveTargetPath` / `parseScope`（paths.ts）、`readRegistry` / `addEntry` / `findByName`（registry.ts）、`readStamp` / `writeStamp` / `parseStamp`（stamp.ts）、`fetchIndex`（index-fetch.ts）、`downloadSkillToTarget`（skill-fetch.ts）、`detectOutdated` / `detectOutdatedCached`（stale-check.ts）、`runDoctor`（doctor.ts）、`matchSkills`（match.ts）、`emitError`（errors.ts）。
- 上游：`src/commands/*`、`src/cli.ts`、`tests/*.test.ts`。
- 下游：Node 标准库（`node:fs` / `node:os` / `node:path` / `node:child_process`）、`fuse.js`、`fetch`（global）。
- 禁止依赖：NEVER 依赖 `src/commands/`（反向依赖会让 lib 无法独立测试）；NEVER 依赖 `commander`（命令解析是 commands 层职责）。

### src/commands
- 职责边界：把 commander 子命令的 action 落到具体业务流程——解析 flag、调 lib、向 stdout 写人话或 JSON、按 `TfsError.exit_code` 退出。一个文件对应一个 `tfs` 子命令；命令之间互相不知道彼此存在。MUST 把所有用户可见输出收敛到这一层。
- 入口：每个 `src/commands/<name>.ts` 命名导出 `<name>Command`（如 `installCommand` / `doctorCommand` / `initCommand`），签名匹配 commander action `(args..., opts) => Promise<void>`。在 `src/cli.ts` 被 `.action()` 注册。
- 上游：`src/cli.ts`（唯一调用方）；`tests/<command>.test.ts`（直接调 action 函数做集成测试，必要时 mock lib）。
- 下游：`src/lib/*`、`commander`（仅参数对象类型）、`node:fs`（rm / existsSync 等）、`process`（exit / stdout）。
- 禁止依赖：NEVER `import` 另一个 `src/commands/*`（共享逻辑下沉到 lib）；NEVER 复制 lib 已封装好的能力（如自己再写一遍 stamp 解析、自己再 fetch index）。
