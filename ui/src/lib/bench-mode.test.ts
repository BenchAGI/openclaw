// @vitest-environment node
import { describe, expect, it } from "vitest";
import { benchAppHref, benchVaultHref, isBenchVaultHost } from "./bench-mode.ts";

describe("bench mode hrefs", () => {
  it("carries the agent to the App and marks the origin", () => {
    expect(benchAppHref("aurelius")).toBe("https://benchagi.com/app?agent=aurelius&from=vault");
    expect(benchAppHref(" cole ")).toBe("https://benchagi.com/app?agent=cole&from=vault");
    expect(benchAppHref(null)).toBe("https://benchagi.com/app?from=vault");
  });

  it("points the Vault side at the bare origin root the witness expects", () => {
    expect(benchVaultHref({ origin: "https://prime-cell.openclaw.benchagi.com" })).toBe(
      "https://prime-cell.openclaw.benchagi.com/",
    );
  });

  it("reads the Vault host stamp and nothing else", () => {
    const root = { dataset: { benchHost: "aurelius-vault" } } as unknown as HTMLElement;
    expect(isBenchVaultHost(root)).toBe(true);
    expect(isBenchVaultHost({ dataset: {} } as unknown as HTMLElement)).toBe(false);
    expect(isBenchVaultHost(null)).toBe(false);
  });
});
