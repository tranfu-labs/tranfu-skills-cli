import { program, CommanderError } from "commander";
import { searchCommand } from "./commands/search.js";
import { installCommand } from "./commands/install.js";
import { listCommand } from "./commands/list.js";
import { installedCommand } from "./commands/installed.js";
import { uninstallCommand } from "./commands/uninstall.js";
import { updateCommand } from "./commands/update.js";
import { doctorCommand } from "./commands/doctor.js";
import { initCommand } from "./commands/init.js";
import { emitError } from "./lib/errors.js";
import pkg from "../package.json" with { type: "json" };

program.name("tfs").version(pkg.version);
program.exitOverride();
// 抑制 commander 自身的人话 stderr; 错误统一走 emitError 的 JSON
program.configureOutput({ writeErr: () => {} });

program
  .command("search <query>")
  .description("搜公司 skill 库")
  .option("--top <n>", "返回前 N 条", "5")
  .option("--json", "JSON 输出")
  .option("--runtime <runtime>", "(忽略, 搜索 runtime-agnostic; 接受 flag 让 router 调用一致)")
  .action(searchCommand);

program
  .command("install <skill>")
  .description("装公司 skill 到本地")
  .option("--scope <scope>", "user 或 project (TTY 未传则弹选, 非 TTY 默认 user)")
  .option("--runtime <runtime>", "claude-code 或 codex (TTY 未传 + 双 runtime 弹选, 非 TTY 走探测)")
  .option("--force", "强制覆盖已存在的同名目录 (对 absent / partial 戳生效)")
  .action(installCommand);

program
  .command("list")
  .description("列出公司库 (远端) 全部 skill")
  .option("--json", "JSON 输出")
  .option("--runtime <runtime>", "(忽略, 远端 list 与本地 runtime 无关; 接受 flag 让 router 一致)")
  .action(listCommand);

program
  .command("installed")
  .description("列出本地已装的公司 skill (默认跨 runtime + scope 全列, 显式 flag 收窄)")
  .option("--scope <scope>", "user 或 project (未传则不过滤, 全列)")
  .option("--runtime <runtime>", "claude-code 或 codex (未传则不过滤, 全列)")
  .option("--json", "JSON 输出")
  .action(installedCommand);

program
  .command("uninstall <skill>")
  .description("卸载已装的公司 skill (无 flag 时从 registry 查全部位置)")
  .option("--scope <scope>", "user 或 project (未传则从 registry 查全部)")
  .option("--runtime <runtime>", "claude-code 或 codex (未传则从 registry 查全部)")
  .action(uninstallCommand);

program
  .command("init")
  .description("一次性 bootstrap: 装 tranfu-router + tranfu-publish meta-skill 到当前 runtime")
  .option("--runtime <runtime>", "claude-code 或 codex (未传单 runtime 自动探测; 多 runtime + TTY 走交互)")
  .option("--both", "装到所有探到的 runtime (claude-code + codex)")
  .action(initCommand);

program
  .command("doctor")
  .description("诊断本机环境 (Node 版本 / runtime / PATH / 旧缓存)")
  .option("--json", "JSON 输出")
  .action(doctorCommand);

program
  .command("update")
  .description("升级 CLI 自身 / 已装 skill (默认两者都升)")
  .option("--self", "仅升级 CLI 自身 (npm install -g)")
  .option("--skills-only", "仅升级已装 skill")
  .option("--ack-deletions", "把当前 deleted-upstream 的 skill 写入 ack.json, 静默后续 warn")
  .option("--check-only", "仅检测哪些 skill 可更新, 不动文件 (与 --self / --ack-deletions 互斥)")
  .option("--json", "JSON 输出")
  .action(updateCommand);

try {
  await program.parseAsync(process.argv);
} catch (err) {
  if (err instanceof CommanderError) {
    // --version / --help 是正常退出, 不是错误
    if (
      err.code === "commander.version" ||
      err.code === "commander.help" ||
      err.code === "commander.helpDisplayed"
    ) {
      process.exit(0);
    }
    // 其他 commander 错误 (missingArgument / unknownOption / unknownCommand 等) 转 TfsError JSON
    emitError({
      error: "invalid_args",
      message: err.message,
      hint: "tfs --help 查看用法",
      exit_code: 1,
    });
  }
  throw err;
}
