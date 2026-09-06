/* @vitest-environment jsdom */

import { render } from "lit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import { renderAbout } from "./view.ts";

type AboutProps = Parameters<typeof renderAbout>[0];

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const COMMIT_AT = "2026-07-10T11:22:33.000Z";
const BUILT_AT = "2026-07-10T12:34:56.000Z";

function createProps(overrides: Partial<AboutProps> = {}): AboutProps {
  return {
    buildInfo: {
      version: "2026.7.10",
      commit: COMMIT,
      commitAt: COMMIT_AT,
      builtAt: BUILT_AT,
      branch: "feature/build-chip",
      dirty: true,
      release: false,
      buildId: "test",
    },
    gatewayVersion: "2026.7.9",
    copyState: "idle",
    onCopyCommit: vi.fn(),
    aureliusGreeting: false,
    onGreetAurelius: vi.fn(),
    ...overrides,
  };
}

describe("renderAbout", () => {
  beforeEach(async () => {
    document.body.innerHTML = "";
    await i18n.setLocale("en");
  });

  it("renders the hero with Aurelius, identity, community links, and license", () => {
    const onGreetAurelius = vi.fn();
    const container = document.createElement("div");
    render(renderAbout(createProps({ onGreetAurelius })), container);

    const hero = container.querySelector(".about-hero");
    expect(hero?.querySelector(".about-hero__name")?.textContent).toBe("BenchAGI Aurelius Vault");
    expect(hero?.querySelector(".about-hero__version")?.textContent).toBe("v2026.7.10");
    expect(hero?.querySelector(".about-hero__aurelius openclaw-mascot")).not.toBeNull();

    const aurelius = hero?.querySelector<HTMLButtonElement>(".about-hero__aurelius");
    expect(aurelius?.getAttribute("aria-label")).toBe("Say hi to Aurelius");
    aurelius?.click();
    expect(onGreetAurelius).toHaveBeenCalledOnce();

    const links = Array.from(hero?.querySelectorAll<HTMLAnchorElement>(".about-hero__link") ?? []);
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "https://benchagi.com",
      "https://benchagi.com/support",
      "https://benchagi.com/blog",
      "https://benchagi.com/agents",
    ]);
    expect(links.map((link) => link.textContent?.trim())).toEqual([
      "Website",
      "Get help",
      "What's new",
      "Your agents",
    ]);
    for (const link of links) {
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
      expect(link.getAttribute("rel")).toContain("noreferrer");
    }

    expect(container.querySelector(".about-footer")?.textContent).toContain("MIT licensed");
    expect(container.querySelector(".about-footer")?.textContent).toContain(
      "trademarks of BenchAGI",
    );
  });

  it("adds the runtime line and the cell row when the host provides them", () => {
    const container = document.createElement("div");
    render(
      renderAbout(
        createProps({
          runtime: "bench-runtime-2026.9.2",
          cell: { name: "Prime cell", user: "cory@benchagi.com" },
        }),
      ),
      container,
    );
    const facts = container.querySelector(".settings-kv");
    const rows = [...(facts?.querySelectorAll("dt") ?? [])].map((row) => row.textContent?.trim());
    expect(rows).toEqual(["Version", "Commit", "Branch", "Built", "Runtime", "Cell"]);
    const values = facts?.querySelectorAll("dd");
    expect(values?.[4]?.querySelector("code")?.textContent).toBe("bench-runtime-2026.9.2");
    expect(values?.[5]?.textContent?.trim()).toBe("Prime cell · cory@benchagi.com");
    expect(container.querySelector(".about-hero__glyph svg")).not.toBeNull();
  });

  it("names the local gateway when the cell has no environment label", () => {
    const container = document.createElement("div");
    render(renderAbout(createProps({ cell: { name: null, user: null } })), container);
    const values = container.querySelectorAll(".settings-kv dd");
    expect(values[values.length - 1]?.textContent?.trim()).toBe("Local gateway");
  });

  it("marks the hero as waving only while a poke is active", () => {
    const container = document.createElement("div");
    render(renderAbout(createProps({ aureliusGreeting: true })), container);
    expect(container.querySelector(".about-hero__aurelius--greeting")).not.toBeNull();

    render(renderAbout(createProps({ aureliusGreeting: false })), container);
    expect(container.querySelector(".about-hero__aurelius--greeting")).toBeNull();
  });

  it("keeps version, commit, branch, and localized UTC build date in one facts grid", () => {
    const container = document.createElement("div");
    render(renderAbout(createProps()), container);

    const facts = container.querySelector(".settings-kv");
    const values = facts?.querySelectorAll("dd");
    expect(facts?.getAttribute("role")).toBe("group");
    expect(facts?.getAttribute("aria-label")).toBe("Control UI build details");
    expect(facts?.classList.contains("about-build-grid")).toBe(true);
    expect(values).toHaveLength(4);
    expect(values?.[0]?.textContent).toContain("2026.7.10");
    expect(values?.[1]?.querySelector("code")?.textContent).toBe(COMMIT.slice(0, 12));
    expect(values?.[1]?.querySelector("code")?.getAttribute("title")).toBe(COMMIT);
    expect(values?.[1]?.querySelector("code")?.getAttribute("dir")).toBe("ltr");

    const commitAge = values?.[1]?.querySelector("time.about-commit__age");
    expect(commitAge?.getAttribute("datetime")).toBe(COMMIT_AT);
    expect(commitAge?.textContent?.trim()).not.toBe("");
    expect(commitAge?.getAttribute("title")).toBe(
      new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" }).format(
        new Date(COMMIT_AT),
      ),
    );
    expect(commitAge?.nextElementSibling?.tagName.toLowerCase()).toBe("openclaw-tooltip");

    expect(values?.[2]?.textContent).toContain("feature/build-chip*");

    const time = values?.[3]?.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe(BUILT_AT);
    expect(time?.getAttribute("title")).toBe(BUILT_AT);
    expect(time?.getAttribute("dir")).toBe("auto");
    expect(time?.textContent).toBe(
      new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(
        new Date(BUILT_AT),
      ),
    );
  });

  it("keeps the commit hash without an age when no commit timestamp is embedded", () => {
    const container = document.createElement("div");
    const props = createProps();
    render(renderAbout({ ...props, buildInfo: { ...props.buildInfo, commitAt: null } }), container);

    expect(container.querySelector(".about-commit code")?.textContent).toBe(COMMIT.slice(0, 12));
    expect(container.querySelector(".about-commit__age")).toBeNull();
  });

  it("keeps the connected Gateway version separate from the browser artifact", () => {
    const container = document.createElement("div");
    render(renderAbout(createProps()), container);

    expect(container.querySelector(".settings-kv")?.textContent).not.toContain("2026.7.9");
    const gatewayRow = container.querySelectorAll(".settings-row")[0];
    expect(gatewayRow?.textContent).toContain("2026.7.9");
    expect(gatewayRow?.textContent).toContain("separate from this Control UI build");
  });

  it("copies the full commit while announcing success accessibly", () => {
    const onCopyCommit = vi.fn();
    const container = document.createElement("div");
    render(renderAbout(createProps({ copyState: "copied", onCopyCommit })), container);

    const button = container.querySelector<HTMLButtonElement>(".about-commit button");
    expect(button?.getAttribute("aria-label")).toBe("Commit hash copied");
    expect(container.querySelector("[role='status']")?.textContent?.trim()).toBe(
      "Commit hash copied",
    );
    button?.click();
    expect(onCopyCommit).toHaveBeenCalledOnce();
  });

  it("states when artifact identity and Gateway version are unavailable", () => {
    const container = document.createElement("div");
    render(
      renderAbout(
        createProps({
          buildInfo: {
            version: null,
            commit: null,
            commitAt: null,
            builtAt: null,
            branch: null,
            dirty: null,
            release: false,
            buildId: "dev",
          },
          gatewayVersion: null,
        }),
      ),
      container,
    );

    expect(container.querySelectorAll(".settings-kv .muted")).toHaveLength(3);
    expect(container.querySelector(".settings-row__value")?.textContent).toContain("Unavailable");
    expect(container.querySelector(".about-commit button")).toBeNull();
    expect(container.textContent).not.toContain("Unknown build");
  });
});
