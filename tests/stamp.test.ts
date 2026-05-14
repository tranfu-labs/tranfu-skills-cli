import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseStamp,
  readStamp,
  writeStamp,
  type StampData,
} from "../src/lib/stamp.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = join(tmpdir(), `stamp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

const completeStamp: StampData = {
  installed_by: "tranfu-skills",
  installed_version: "abc123",
  installed_at: "2026-05-14",
  installed_source: "own",
};

describe("parseStamp — 三态识别", () => {
  it("intact: 4 个字段齐全 → status=intact + data", () => {
    const md = `---
name: foo-skill
description: A test skill
installed_by: tranfu-skills
installed_version: abc123
installed_at: 2026-05-14
installed_source: own
---

body
`;
    const r = parseStamp(md);
    expect(r.status).toBe("intact");
    if (r.status === "intact") {
      expect(r.data.installed_version).toBe("abc123");
      expect(r.data.installed_source).toBe("own");
    }
  });

  it("partial: 有 installed_by 但缺 installed_version → status=partial", () => {
    const md = `---
name: foo-skill
installed_by: tranfu-skills
installed_at: 2026-05-14
installed_source: own
---
`;
    const r = parseStamp(md);
    expect(r.status).toBe("partial");
    if (r.status === "partial") {
      expect(r.partial.installed_by).toBe("tranfu-skills");
      expect(r.partial.installed_version).toBeUndefined();
    }
  });

  it("partial: installed_source 值非法 → status=partial", () => {
    const md = `---
installed_by: tranfu-skills
installed_version: abc123
installed_at: 2026-05-14
installed_source: bogus
---
`;
    const r = parseStamp(md);
    expect(r.status).toBe("partial");
  });

  it("absent: 完全没有 installed_by 字段 → status=absent", () => {
    const md = `---
name: user-handmade-skill
description: I made this myself
---
`;
    expect(parseStamp(md).status).toBe("absent");
  });

  it("absent: 完全没有 frontmatter → status=absent", () => {
    expect(parseStamp("just body text, no fm").status).toBe("absent");
  });

  it("absent: installed_by 值不是 tranfu-skills → status=absent (别人的戳)", () => {
    const md = `---
installed_by: some-other-tool
---
`;
    expect(parseStamp(md).status).toBe("absent");
  });
});

describe("readStamp", () => {
  it("文件不存在 → status=absent (不抛异常)", () => {
    const r = readStamp(join(tmpDir, "nonexistent.md"));
    expect(r.status).toBe("absent");
  });

  it("读真实文件 → 与 parseStamp 一致", () => {
    const path = join(tmpDir, "SKILL.md");
    writeFileSync(path, `---
installed_by: tranfu-skills
installed_version: xyz
installed_at: 2026-05-14
installed_source: meta
---
`);
    const r = readStamp(path);
    expect(r.status).toBe("intact");
  });
});

describe("writeStamp", () => {
  it("无 frontmatter 文件 → 创建一个 frontmatter 块在最前", () => {
    const path = join(tmpDir, "SKILL.md");
    writeFileSync(path, "# Plain body, no fm\n");
    writeStamp(path, completeStamp);
    const md = readFileSync(path, "utf8");
    expect(md).toMatch(/^---\n[\s\S]*installed_by: tranfu-skills/);
    expect(md).toContain("# Plain body, no fm");
  });

  it("已有 frontmatter (无戳) → 追加 stamp 字段, 保留原字段", () => {
    const path = join(tmpDir, "SKILL.md");
    writeFileSync(path, `---
name: foo
description: bar
---

body
`);
    writeStamp(path, completeStamp);
    const md = readFileSync(path, "utf8");
    expect(md).toContain("name: foo");
    expect(md).toContain("description: bar");
    expect(md).toContain("installed_by: tranfu-skills");
    expect(md).toContain("installed_version: abc123");
    expect(md).toContain("\nbody\n");
  });

  it("已有 stamp → 覆盖, 不重复 append", () => {
    const path = join(tmpDir, "SKILL.md");
    writeFileSync(path, `---
name: foo
installed_by: tranfu-skills
installed_version: OLD
installed_at: 2020-01-01
installed_source: own
---
`);
    writeStamp(path, { ...completeStamp, installed_version: "NEW" });
    const md = readFileSync(path, "utf8");
    expect(md).toContain("installed_version: NEW");
    expect(md).not.toContain("installed_version: OLD");
    // 只出现一次, 不是 append 2 份
    expect(md.match(/installed_by: tranfu-skills/g)?.length).toBe(1);
  });

  it("不破坏 block scalar description (>)", () => {
    const path = join(tmpDir, "SKILL.md");
    writeFileSync(path, `---
name: bs-skill
description: >
  line one
  line two
version: 0.1.0
---

# body
`);
    writeStamp(path, completeStamp);
    const md = readFileSync(path, "utf8");
    expect(md).toContain("description: >");
    expect(md).toContain("  line one");
    expect(md).toContain("  line two");
    expect(md).toContain("installed_by: tranfu-skills");
  });

  it("writeStamp + readStamp 往返一致", () => {
    const path = join(tmpDir, "SKILL.md");
    writeFileSync(path, "# body\n");
    writeStamp(path, completeStamp);
    const r = readStamp(path);
    expect(r.status).toBe("intact");
    if (r.status === "intact") {
      expect(r.data).toEqual(completeStamp);
    }
  });
});
