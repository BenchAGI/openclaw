// -- Bench Harness Manifest gate -------------------------------------------
// Extracted from serve.mjs so the failure paths are directly testable.
//
// BENCH_HARNESS_MANIFEST_ENFORCE is an AUTHORIZATION boundary, not availability
// filtering: the allowlist is published by the super-admin and scoped by a rarity
// ceiling, and it decides which shared-vault pages a customer harness may read.
// So an operator who opted in must never be served unapproved pages because we
// could not reach the manifest — unknown state denies.
//
// The four states the boundary has to answer for:
//   enforcement off      → allow everything (default; unchanged)
//   never loaded         → deny (startup fetch failed, or still in flight)
//   loaded, empty        → deny everything (an empty allowlist approves nothing)
//   loaded, then stale   → serve last-known-good until maxStaleMs, then deny
//
// Retaining last-known-good across a transient refresh failure keeps a blip from
// blacking out a working harness; bounding it keeps a revoked slug from staying
// readable forever.

export const DEFAULT_MAX_STALE_MULTIPLIER = 3;

export function normalizeWikiPath(value) {
  if (typeof value !== "string") {
    return null;
  }
  return value.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\.md$/i, "");
}

/** Pull the approved slugs out of either manifest response shape. */
export function parseManifestSlugs(body) {
  const slugs = new Set();
  if (Array.isArray(body?.entries)) {
    for (const entry of body.entries) {
      const norm = normalizeWikiPath(entry?.slug);
      if (norm) {
        slugs.add(norm);
      }
    }
  } else if (Array.isArray(body?.manifest?.approvedSlugs)) {
    for (const slug of body.manifest.approvedSlugs) {
      const norm = normalizeWikiPath(slug);
      if (norm) {
        slugs.add(norm);
      }
    }
  }
  return slugs;
}

export function createHarnessManifestGate({
  enforce = false,
  ceiling = "orange",
  refreshMs = 300_000,
  maxStaleMs = null,
  now = () => Date.now(),
} = {}) {
  let allowedSlugs = null; // null = never loaded
  let manifestVersion = 0;
  let loadedAt = 0;

  const staleAfter = maxStaleMs ?? refreshMs * DEFAULT_MAX_STALE_MULTIPLIER;

  /** Loaded and still fresh enough to authorize against. */
  function hasUsableManifest() {
    if (allowedSlugs === null) {
      return false;
    }
    return now() - loadedAt <= staleAfter;
  }

  function applyManifest(body) {
    allowedSlugs = parseManifestSlugs(body);
    manifestVersion =
      typeof body?.manifest?.manifestVersion === "number" ? body.manifest.manifestVersion : 0;
    loadedAt = now();
    return allowedSlugs.size;
  }

  function isAllowedSlug(value) {
    if (!enforce) {
      return true;
    }
    // Enforcing with no usable manifest: we cannot show this page is approved.
    if (!hasUsableManifest()) {
      return false;
    }
    const norm = normalizeWikiPath(value);
    if (!norm) {
      return false;
    }
    if (allowedSlugs.has(norm)) {
      return true;
    }
    // Tolerate nested paths: a slug "inbox/foo" should match a lookup of
    // "inbox/foo.md" (already stripped) or the title embedded in a path.
    for (const allowed of allowedSlugs) {
      if (norm === allowed || norm.endsWith(`/${allowed}`) || allowed.endsWith(`/${norm}`)) {
        return true;
      }
    }
    return false;
  }

  function denialReason() {
    if (allowedSlugs === null) {
      return "manifest-unavailable";
    }
    if (now() - loadedAt > staleAfter) {
      return "manifest-stale";
    }
    return "not-approved";
  }

  function manifestMeta(filteredOut) {
    return { version: manifestVersion, filteredOut, ceiling, reason: denialReason() };
  }

  function filterSearchPayload(payload) {
    if (!enforce) {
      return payload;
    }
    if (!payload || typeof payload !== "object") {
      return payload;
    }
    const data = payload.data ?? payload;
    if (!data || typeof data !== "object") {
      return payload;
    }
    const results = Array.isArray(data.results)
      ? data.results
      : Array.isArray(data.matches)
        ? data.matches
        : Array.isArray(data.items)
          ? data.items
          : null;
    if (!results) {
      return payload;
    }

    let filteredCount = 0;
    const filtered = results.filter((row) => {
      const candidate = row?.path ?? row?.slug ?? row?.title ?? row?.lookup ?? row?.id ?? null;
      const allowed = isAllowedSlug(candidate);
      if (!allowed) {
        filteredCount += 1;
      }
      return allowed;
    });

    if (filteredCount === 0) {
      return payload;
    }

    const next = { ...data };
    if (Array.isArray(data.results)) {
      next.results = filtered;
    }
    if (Array.isArray(data.matches)) {
      next.matches = filtered;
    }
    if (Array.isArray(data.items)) {
      next.items = filtered;
    }
    next.harnessManifest = manifestMeta(filteredCount);
    return payload.data !== undefined ? { ...payload, data: next } : next;
  }

  return {
    applyManifest,
    isAllowedSlug,
    filterSearchPayload,
    hasUsableManifest,
    denialReason,
    get manifestVersion() {
      return manifestVersion;
    },
  };
}
