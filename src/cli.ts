import { program } from "commander";
import { searchCommand } from "./commands/search.js";
import pkg from "../package.json" with { type: "json" };

program.name("tfs").version(pkg.version);

program
  .command("search <query>")
  .description("搜公司 skill 库")
  .option("--top <n>", "返回前 N 条", "5")
  .option("--json", "JSON 输出")
  .action(searchCommand);

program.parseAsync(process.argv);
