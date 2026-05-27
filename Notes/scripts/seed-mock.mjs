import { join } from "node:path";
import { createRepository } from "../src/data/repository.mjs";

const repository = createRepository({ dbPath: join(process.cwd(), "data", "notes.db") });
await repository.init();

const now = Date.now();
const folders = [
  { id: "notes", name: "备忘录", createdAt: now - 1000 * 60 * 60 * 24 * 30, updatedAt: now },
  ...Array.from({ length: 22 }, (_, index) => ({
    id: `mock-folder-${index + 1}`,
    name: `测试分类 ${String(index + 1).padStart(2, "0")}`,
    createdAt: now - 1000 * 60 * 60 * (22 - index),
    updatedAt: now - 1000 * 60 * index
  }))
];

const longParagraph = [
  "这是一段用于测试内容滚动的长文本。",
  "移动端需要在内容页保持顶部返回栏和底部编辑按钮稳定。",
  "桌面端需要编辑区自己滚动，不应该把分类和列表一起带走。",
  "这里故意写得比较长，用来观察换行、行高和滚动条表现。"
].join("");

const notes = Array.from({ length: 96 }, (_, index) => {
  const folder = index < 18 ? "notes" : `mock-folder-${(index % 22) + 1}`;
  const lines = Array.from({ length: index % 9 === 0 ? 46 : 8 }, (__, lineIndex) => {
    if (lineIndex === 0) return `测试笔记 ${String(index + 1).padStart(3, "0")}`;
    if (lineIndex % 6 === 0) return `- 列表项 ${lineIndex}: 检查列表和正文滚动`;
    return `${lineIndex}. ${longParagraph}`;
  });

  return {
    id: `mock-note-${index + 1}`,
    folder,
    body: lines.join("\n\n"),
    createdAt: now - 1000 * 60 * 60 * index,
    updatedAt: now - 1000 * 60 * index
  };
});

await repository.writeState({ folders, notes });
console.log(`Seeded ${folders.length} folders and ${notes.length} notes.`);
