import { createInterface } from "node:readline";

interface SelectOptions {
  question: string;
  choices: string[];
  allowAll?: boolean;
}

export type SelectResult = number | "all" | "quit";

/**
 * 最小零依赖 select prompt. 列编号选项, 读一行 stdin.
 * 返回选中 index, 或 "all" / "quit".
 *
 * 仅在 TTY 调用 — 调用方先 isTTY 守卫.
 */
export async function selectFromList(opts: SelectOptions): Promise<SelectResult> {
  process.stdout.write(`${opts.question}\n`);
  for (let i = 0; i < opts.choices.length; i++) {
    process.stdout.write(`  ${i + 1}. ${opts.choices[i]}\n`);
  }
  const tail = opts.allowAll ? "1-N / a=all / q=quit" : "1-N / q=quit";
  const promptLine = `pick (${tail}): `;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const ans: string = await new Promise((resolve) => rl.question(promptLine, resolve));
      const trimmed = ans.trim().toLowerCase();
      if (trimmed === "q" || trimmed === "quit" || trimmed === "") return "quit";
      if (opts.allowAll && (trimmed === "a" || trimmed === "all")) return "all";
      const n = Number.parseInt(trimmed, 10);
      if (Number.isInteger(n) && n >= 1 && n <= opts.choices.length) {
        return n - 1;
      }
      process.stdout.write(`输入无效, 请输 1-${opts.choices.length}${opts.allowAll ? " / a" : ""} / q\n`);
    }
  } finally {
    rl.close();
  }
}

export function isInteractive(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
