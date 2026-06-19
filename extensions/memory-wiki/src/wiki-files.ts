// Memory Wiki plugin module implements wiki file discovery behavior.
import fs from "node:fs/promises";
import path from "node:path";

export async function collectWikiMarkdownFiles(
  rootDir: string,
  relativeDir: string,
  options?: { recursive?: boolean },
): Promise<string[]> {
  const generatedIndexPath = path.join(relativeDir, "index.md");

  async function walk(currentRelativeDir: string): Promise<string[]> {
    const dirPath = path.join(rootDir, currentRelativeDir);
    const entries = await fs.readdir(dirPath, { withFileTypes: true }).catch(() => []);
    const files = await Promise.all(
      entries.map(async (entry) => {
        const entryRelativePath = path.join(currentRelativeDir, entry.name);
        if (entry.isDirectory() && options?.recursive) {
          return walk(entryRelativePath);
        }
        if (
          !entry.isFile() ||
          !entry.name.endsWith(".md") ||
          entryRelativePath === generatedIndexPath
        ) {
          return [];
        }
        return [entryRelativePath];
      }),
    );
    return files.flat().toSorted((left, right) => left.localeCompare(right));
  }

  return walk(relativeDir);
}
