import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { readRegularFile } from "openclaw/plugin-sdk/security-runtime";

export const DREAMS_FILENAMES = ["DREAMS.md", "dreams.md"] as const;

function isEmptyDreamsReadError(err: unknown): boolean {
  const code = extractErrorCode(err);
  if (
    code === "ENOENT" ||
    code === "ENOTDIR" ||
    code === "not-found" ||
    code === "not-file" ||
    code === "path-alias" ||
    code === "path-mismatch" ||
    code === "symlink"
  ) {
    return true;
  }
  return err instanceof Error && err.message === "path must be a regular file";
}

// Origin retention reads diary artifacts without importing their policy-aware publisher.
export async function readDreamsFile(dreamsPath: string): Promise<string> {
  try {
    return (await readRegularFile({ filePath: dreamsPath })).buffer.toString("utf-8");
  } catch (err) {
    if (isEmptyDreamsReadError(err)) {
      return "";
    }
    throw err;
  }
}
