// @vitest-environment node
import { describe, expect, it } from "vitest";
import { calmMotionRequested, isEmbeddedWebKitHost, resolveMotionPresentation } from "./motion.ts";

const SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36";
const FIREFOX =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.6; rv:130.0) Gecko/20100101 Firefox/130.0";
const ELECTRON =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) app/1.0 Chrome/128.0.0.0 Electron/32.0.0 Safari/537.36";
const WKWEBVIEW =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
const VAULT = `${WKWEBVIEW} AureliusVault/0.2.0`;

describe("isEmbeddedWebKitHost", () => {
  it("treats every full browser as not embedded", () => {
    for (const userAgent of [SAFARI, CHROME, FIREFOX, ELECTRON]) {
      expect(isEmbeddedWebKitHost(userAgent)).toBe(false);
    }
  });

  it("detects a bare WKWebView and the explicit Vault marker", () => {
    expect(isEmbeddedWebKitHost(WKWEBVIEW)).toBe(true);
    expect(isEmbeddedWebKitHost(VAULT)).toBe(true);
    expect(isEmbeddedWebKitHost(`${CHROME} AureliusVault/0.2.0`)).toBe(true);
  });

  it("never matches an empty or non-WebKit string", () => {
    expect(isEmbeddedWebKitHost("")).toBe(false);
    expect(isEmbeddedWebKitHost("curl/8.7.1")).toBe(false);
  });
});

describe("resolveMotionPresentation", () => {
  const calm = { prefersReducedMotion: false, embeddedHost: false };

  it("auto follows the OS preference and the embedded host", () => {
    expect(resolveMotionPresentation("auto", calm)).toBe("full");
    expect(resolveMotionPresentation(undefined, calm)).toBe("full");
    expect(resolveMotionPresentation("auto", { ...calm, prefersReducedMotion: true })).toBe(
      "reduced",
    );
    expect(resolveMotionPresentation("auto", { ...calm, embeddedHost: true })).toBe("reduced");
  });

  it("explicit choices win over the environment", () => {
    expect(
      resolveMotionPresentation("full", { prefersReducedMotion: true, embeddedHost: true }),
    ).toBe("full");
    expect(resolveMotionPresentation("reduced", calm)).toBe("reduced");
  });
});

describe("calmMotionRequested", () => {
  it("is false without a document", () => {
    expect(calmMotionRequested()).toBe(false);
  });
});
