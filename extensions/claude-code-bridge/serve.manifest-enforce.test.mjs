import assert from "node:assert/strict";
import { test } from "node:test";

const serveUrl = new URL("./serve.mjs", import.meta.url).href;
let moduleId = 0;

function response(body) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    async json() {
      return body;
    },
  };
}

async function withManifestModule({ enforce, fetchImpl }, callback) {
  const previousEnforce = process.env.BENCH_HARNESS_MANIFEST_ENFORCE;
  const previousFetch = globalThis.fetch;
  process.env.BENCH_HARNESS_MANIFEST_ENFORCE = enforce ? "true" : "false";
  globalThis.fetch = fetchImpl;
  try {
    const manifestModule = await import(`${serveUrl}?test=${moduleId++}`);
    return await callback(manifestModule);
  } finally {
    if (previousEnforce === undefined) {
      delete process.env.BENCH_HARNESS_MANIFEST_ENFORCE;
    } else {
      process.env.BENCH_HARNESS_MANIFEST_ENFORCE = previousEnforce;
    }
    globalThis.fetch = previousFetch;
  }
}

function searchPayload() {
  return {
    data: {
      results: [{ path: "approved/page.md" }, { path: "blocked/page.md" }],
    },
  };
}

test("enforcement fails closed while unknown and after an initial fetch failure", async () => {
  await withManifestModule(
    {
      enforce: true,
      fetchImpl: async () => {
        throw new Error("manifest unavailable");
      },
    },
    async ({ fetchHarnessManifest, filterSearchResultByManifest, isHarnessAllowedSlug }) => {
      assert.equal(isHarnessAllowedSlug("approved/page"), false);
      assert.deepEqual(filterSearchResultByManifest(searchPayload()).data.results, []);

      await fetchHarnessManifest();

      assert.equal(isHarnessAllowedSlug("approved/page"), false);
      const filtered = filterSearchResultByManifest(searchPayload());
      assert.deepEqual(filtered.data.results, []);
      assert.equal(filtered.data.harnessManifest.filteredOut, 2);
    },
  );
});

test("a successful empty manifest denies every wiki entry", async () => {
  await withManifestModule(
    {
      enforce: true,
      fetchImpl: async () => response({ manifest: { manifestVersion: 4, approvedSlugs: [] } }),
    },
    async ({ fetchHarnessManifest, filterSearchResultByManifest, isHarnessAllowedSlug }) => {
      await fetchHarnessManifest();

      assert.equal(isHarnessAllowedSlug("any/page"), false);
      const filtered = filterSearchResultByManifest(searchPayload());
      assert.deepEqual(filtered.data.results, []);
      assert.deepEqual(filtered.data.harnessManifest, {
        version: 4,
        filteredOut: 2,
        ceiling: "orange",
      });
    },
  );
});

test("a failed refresh clears the previous allowlist until a later success", async () => {
  let attempt = 0;
  await withManifestModule(
    {
      enforce: true,
      fetchImpl: async () => {
        attempt += 1;
        if (attempt === 1) {
          return response({
            entries: [{ slug: "approved/page.md" }],
            manifest: { manifestVersion: 7 },
          });
        }
        if (attempt === 2) {
          throw new Error("refresh unavailable");
        }
        return response({
          entries: [{ slug: "reapproved/page.md" }],
          manifest: { manifestVersion: 8 },
        });
      },
    },
    async ({ fetchHarnessManifest, isHarnessAllowedSlug }) => {
      await fetchHarnessManifest();
      assert.equal(isHarnessAllowedSlug("approved/page"), true);

      await fetchHarnessManifest();
      assert.equal(isHarnessAllowedSlug("approved/page"), false);

      await fetchHarnessManifest();
      assert.equal(isHarnessAllowedSlug("approved/page"), false);
      assert.equal(isHarnessAllowedSlug("reapproved/page"), true);
    },
  );
});

test("a failed concurrent refresh cannot retain an older allowlist", async () => {
  let attempt = 0;
  let resolveFirst;
  let rejectSecond;
  await withManifestModule(
    {
      enforce: true,
      fetchImpl: async () => {
        attempt += 1;
        if (attempt === 1) {
          return new Promise((resolve) => {
            resolveFirst = resolve;
          });
        }
        return new Promise((_, reject) => {
          rejectSecond = reject;
        });
      },
    },
    async ({ fetchHarnessManifest, isHarnessAllowedSlug }) => {
      const first = fetchHarnessManifest();
      const second = fetchHarnessManifest();
      resolveFirst(response({ entries: [{ slug: "stale/page.md" }] }));
      await first;
      rejectSecond(new Error("latest refresh unavailable"));
      await second;

      assert.equal(isHarnessAllowedSlug("stale/page"), false);
    },
  );
});

test("default-off enforcement preserves unfiltered behavior", async () => {
  const payload = searchPayload();
  await withManifestModule(
    { enforce: false, fetchImpl: async () => response({ entries: [] }) },
    async ({ fetchHarnessManifest, filterSearchResultByManifest, isHarnessAllowedSlug }) => {
      await fetchHarnessManifest();
      assert.equal(isHarnessAllowedSlug("blocked/page"), true);
      assert.equal(filterSearchResultByManifest(payload), payload);
    },
  );
});
