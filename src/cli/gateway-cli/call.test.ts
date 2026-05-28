import { describe, expect, it, vi } from "vitest";
import { callGatewayCli } from "./call.js";

const mocks = vi.hoisted(() => ({
  callGateway: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("../progress.js", () => ({
  withProgress: async (_opts: unknown, fn: () => Promise<unknown>) => await fn(),
}));

describe("gateway-cli call scope handling", () => {
  it("forwards requested --scope values as the scopes array (least-privilege)", async () => {
    await callGatewayCli("wiki.status", { json: true, scope: ["operator.read"] });

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "wiki.status",
        scopes: ["operator.read"],
      }),
    );
  });

  it("trims and drops blank scope entries", async () => {
    await callGatewayCli("sessions.send", {
      scope: [" operator.read ", "", "   ", "operator.write"],
    });

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ scopes: ["operator.read", "operator.write"] }),
    );
  });

  it("leaves scopes undefined when no --scope is passed so the CLI default set applies", async () => {
    await callGatewayCli("health", { json: true });

    expect(mocks.callGateway).toHaveBeenCalledWith(
      expect.objectContaining({ method: "health", scopes: undefined }),
    );
  });

  it("treats an all-blank scope list as no override", async () => {
    await callGatewayCli("health", { scope: ["", "  "] });

    expect(mocks.callGateway).toHaveBeenCalledWith(expect.objectContaining({ scopes: undefined }));
  });
});
