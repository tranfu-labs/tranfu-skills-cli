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

interface MultiSelectOptions {
  question: string;
  choices: string[];
}

/**
 * 多选 prompt. 接受 "1,3,5" 或 "1 3 5" 或 "a" (全选).
 * 返回 0-based index 数组 (升序去重) 或 "quit".
 */
export async function multiSelectFromList(
  opts: MultiSelectOptions
): Promise<number[] | "quit"> {
  process.stdout.write(`${opts.question}\n`);
  for (let i = 0; i < opts.choices.length; i++) {
    process.stdout.write(`  ${i + 1}. ${opts.choices[i]}\n`);
  }
  const promptLine = `pick (1-${opts.choices.length}, 逗号或空格分隔多选, a=all, q=quit): `;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const ans: string = await new Promise((resolve) =>
        rl.question(promptLine, resolve)
      );
      const trimmed = ans.trim().toLowerCase();
      if (trimmed === "q" || trimmed === "quit" || trimmed === "") return "quit";
      if (trimmed === "a" || trimmed === "all") {
        return opts.choices.map((_, i) => i);
      }
      const parts = trimmed.split(/[,\s]+/).filter(Boolean);
      const indices: number[] = [];
      let valid = true;
      for (const p of parts) {
        const n = Number.parseInt(p, 10);
        if (!Number.isInteger(n) || n < 1 || n > opts.choices.length) {
          valid = false;
          break;
        }
        indices.push(n - 1);
      }
      if (!valid || indices.length === 0) {
        process.stdout.write(
          `输入无效, 试 1${opts.choices.length > 1 ? ` / 1,2 / 1 2 / a` : ""} / q\n`
        );
        continue;
      }
      return [...new Set(indices)].sort((a, b) => a - b);
    }
  } finally {
    rl.close();
  }
}

/**
 * y/N 确认 prompt. 默认 No (空输入 / 非 y/Y → false). 仅 y/yes/Y/YES → true.
 */
export async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans: string = await new Promise((resolve) =>
      rl.question(`${question} (y/N): `, resolve)
    );
    const trimmed = ans.trim().toLowerCase();
    return trimmed === "y" || trimmed === "yes";
  } finally {
    rl.close();
  }
}
