import { program, CommanderError } from "commander";
import { searchCommand } from "./commands/search.js";
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
  .action(searchCommand);

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
