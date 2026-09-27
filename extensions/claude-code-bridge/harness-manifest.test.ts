import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs sibling, no type declarations
import { createHarnessManifestGate, parseManifestSlugs } from "./harness-manifest.mjs";

const APPROVED = { entries: [{ slug: "inbox/approved" }, { slug: "notes/keep.md" }] };

function searchPayload(paths: string[]) {
  return { data: { results: paths.map((path) => ({ path })) } };
}

describe("harness manifest gate — enforcement off (default)", () => {
  it("allows every lookup and never filters search", () => {
    const gate = createHarnessManifestGate({ enforce: false });
    expect(gate.isAllowedSlug("anything/at/all")).toBe(true);
    const payload = searchPayload(["a", "b"]);
    expect(gate.filterSearchPayload(payload)).toBe(payload);
  });
});

describe("harness manifest gate — unknown state fails closed", () => {
  it("denies lookups when the manifest was never loaded", () => {
    const gate = createHarnessManifestGate({ enforce: true });
    expect(gate.isAllowedSlug("inbox/approved")).toBe(false);
    expect(gate.denialReason()).toBe("manifest-unavailable");
  });

  it("returns no search results when the manifest was never loaded", () => {
    const gate = createHarnessManifestGate({ enforce: true });
    const filtered = gate.filterSearchPayload(searchPayload(["inbox/approved", "secret/leak"]));
    expect(filtered.data.results).toEqual([]);
    expect(filtered.data.harnessManifest.reason).toBe("manifest-unavailable");
    expect(filtered.data.harnessManifest.filteredOut).toBe(2);
  });

  it("stays closed after a fetch failure leaves the gate unloaded", () => {
    const gate = createHarnessManifestGate({ enforce: true });
    // fetchHarnessManifest() returns without applying a manifest on HTTP/network error
    expect(gate.hasUsableManifest()).toBe(false);
    expect(gate.isAllowedSlug("inbox/approved")).toBe(false);
  });
});

describe("harness manifest gate — loaded manifest authorizes", () => {
  it("allows approved slugs and denies unapproved ones", () => {
    const gate = createHarnessManifestGate({ enforce: true });
    gate.applyManifest(APPROVED);
    expect(gate.isAllowedSlug("inbox/approved")).toBe(true);
    expect(gate.isAllowedSlug("notes/keep")).toBe(true);
    expect(gate.isAllowedSlug("secret/leak")).toBe(false);
    expect(gate.denialReason()).toBe("not-approved");
  });

  it("filters search down to approved rows", () => {
    const gate = createHarnessManifestGate({ enforce: true });
    gate.applyManifest(APPROVED);
    const filtered = gate.filterSearchPayload(searchPayload(["inbox/approved", "secret/leak"]));
    expect(filtered.data.results.map((r: { path: string }) => r.path)).toEqual(["inbox/approved"]);
  });

  it("treats a successfully loaded EMPTY manifest as approving nothing", () => {
    const gate = createHarnessManifestGate({ enforce: true });
    gate.applyManifest({ entries: [] });
    expect(gate.hasUsableManifest()).toBe(true);
    expect(gate.isAllowedSlug("inbox/approved")).toBe(false);
    expect(gate.denialReason()).toBe("not-approved");
  });

  it("reads the alternate approvedSlugs response shape", () => {
    const gate = createHarnessManifestGate({ enforce: true });
    gate.applyManifest({ manifest: { approvedSlugs: ["inbox/approved"], manifestVersion: 7 } });
    expect(gate.isAllowedSlug("inbox/approved")).toBe(true);
    expect(gate.manifestVersion).toBe(7);
  });
});

describe("harness manifest gate — refresh behavior", () => {
  it("keeps serving a loaded manifest across a transient refresh failure", () => {
    let clock = 1_000;
    const gate = createHarnessManifestGate({
      enforce: true,
      refreshMs: 1_000,
      now: () => clock,
    });
    gate.applyManifest(APPROVED);
    clock += 2_500; // inside maxStale (3 x refreshMs) — refresh failed, nothing reapplied
    expect(gate.isAllowedSlug("inbox/approved")).toBe(true);
  });

  it("closes once the loaded manifest goes stale", () => {
    let clock = 1_000;
    const gate = createHarnessManifestGate({
      enforce: true,
      refreshMs: 1_000,
      now: () => clock,
    });
    gate.applyManifest(APPROVED);
    clock += 3_001; // past maxStale — a revoked slug must not stay readable forever
    expect(gate.isAllowedSlug("inbox/approved")).toBe(false);
    expect(gate.denialReason()).toBe("manifest-stale");
  });

  it("reopens when a later refresh succeeds", () => {
    let clock = 1_000;
    const gate = createHarnessManifestGate({
      enforce: true,
      refreshMs: 1_000,
      now: () => clock,
    });
    gate.applyManifest(APPROVED);
    clock += 3_001;
    expect(gate.isAllowedSlug("inbox/approved")).toBe(false);
    gate.applyManifest(APPROVED);
    expect(gate.isAllowedSlug("inbox/approved")).toBe(true);
  });
});

describe("parseManifestSlugs", () => {
  it("normalizes paths and drops empties", () => {
    const slugs = parseManifestSlugs({
      entries: [{ slug: "/leading.md" }, { slug: "a\\b" }, { slug: "" }, {}],
    });
    expect([...slugs].toSorted()).toEqual(["a/b", "leading"]);
  });
});
