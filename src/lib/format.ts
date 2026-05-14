import type { SkillEntry } from "../types.js";

export function renderJson(results: SkillEntry[]): string {
  return JSON.stringify({
    results: results.map((s) => ({
      name: s.name,
      type: s.type,
      description: s.description,
      path: s.path,
      sha: s.sha,
    })),
    total: results.length,
  });
}

export function renderHuman(query: string, results: SkillEntry[]): string {
  if (results.length === 0) return `没找到 "${query}" 相关的 skill.`;
  const lines = [`${results.length} results for "${query}":`];
  const nameW = Math.max(...results.map((r) => r.name.length));
  for (const s of results) {
    lines.push(
      `  ${s.name.padEnd(nameW)}   ${s.description.slice(0, 60)}   ${s.type}`
    );
  }
  return lines.join("\n");
}
