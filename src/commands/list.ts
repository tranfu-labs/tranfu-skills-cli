import { installedCommand } from "./installed.js";
import { catalogCommand } from "./catalog.js";

/**
 * tfs list (r2 命名重构):
 *   - 默认: 列本地已装 (= tfs installed, 跨 runtime + scope)
 *   - --remote: deprecated, 等价 tfs catalog (列远端公司库 index)
 *
 * `tfs installed` 仍作 alias 保留; `tfs catalog` 是远端 catalog 新名.
 */
export async function listCommand(opts: {
  json?: boolean;
  remote?: boolean;
  runtime?: string;
  scope?: string;
}): Promise<void> {
  if (opts.remote) {
    process.stderr.write(
      "⚠ tfs list --remote is deprecated, use tfs catalog instead\n"
    );
    return catalogCommand({ json: opts.json });
  }
  return installedCommand({
    json: opts.json,
    runtime: opts.runtime,
    scope: opts.scope,
  });
}
