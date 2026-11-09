import { afterEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { NodeRegistry } from "./node-registry.js";
import { makeClient, registerNodeSession } from "./node-registry.test-helpers.js";

const registries: NodeRegistry[] = [];
const pairing = { pairingIdentity: "identity-a", pairingGeneration: "generation-a" };
const transition = {
  expectedConnId: "conn-1",
  expectedPairingIdentity: "identity-a",
  expectedPairingGeneration: "generation-a",
  nextPairingGeneration: "generation-b",
};

function createRegistry(options?: ConstructorParameters<typeof NodeRegistry>[0]) {
  const registry = new NodeRegistry(options);
  registries.push(registry);
  return registry;
}

afterEach(() => {
  for (const registry of registries.splice(0)) {
    registry.unregister("conn-1");
    registry.unregister("conn-2");
  }
});

it("installs the narrowed authority and generation before policy callbacks reenter", () => {
  let reenter = false;
  let currentGeneration = "generation-a";
  const observed = vi.fn();
  const registry = createRegistry({
    isPairingStateCurrent: (_nodeId, expected) =>
      expected.identity === "identity-a" && expected.generation === currentGeneration,
    listRegisteredNodePluginToolCommands: () => {
      if (reenter) {
        reenter = false;
        const node = registry.get("node-1");
        expect(node).toMatchObject({
          pairingGeneration: "generation-b",
          commands: [],
          caps: [],
          permissions: { accessibility: false, microphone: false },
        });
        expect(node?.computerUse).toBeUndefined();
        expect(node?.client.connect).toMatchObject({
          commands: [],
          caps: [],
          permissions: { accessibility: false, microphone: false },
        });
        expect(node?.client.connect.computerUse).toBeUndefined();
        expect(registry.listCurrentConnectedSync()).toEqual([node]);
        // The approved policy itself must already be installed, so a
        // reentrant refresh cannot restore the previously approved commands.
        registry.refreshRuntimePolicy();
        expect(node?.commands).toEqual([]);
        observed();
      }
      return [];
    },
  });
  const computerUse = {
    contractVersion: 2,
    provider: { id: "fixture", label: "Fixture", generation: "provider-1" },
    actions: ["screenshot", "left_click"],
    targets: ["screen"],
    deliveryModes: ["foreground"],
    observations: ["image"],
    features: { recording: false, agentCursor: false, multiDisplay: false },
  };
  const client = makeClient("conn-1", "node-1", [], {
    caps: ["computer"],
    commands: ["computer.act", "screen.snapshot", "system.run"],
    computerUse,
    permissions: { accessibility: true, microphone: true },
  });
  const node = registerNodeSession(registry, client, pairing);
  expect(node.computerUse).toBeDefined();
  currentGeneration = "generation-b";
  reenter = true;

  expect(
    registry.updateSurface(
      "node-1",
      { caps: [], commands: [], permissions: { accessibility: false, microphone: false } },
      transition,
    ),
  ).toBe(node);
  expect(observed).toHaveBeenCalledTimes(1);
  expect(client.invalidated).not.toBe(true);
});

it.each(["replacement", "later generation", "different identity", "invalidated"] as const)(
  "does not promote an approval over a %s session",
  (change) => {
    const registry = createRegistry();
    const first = makeClient("conn-1", "node-1", [], { commands: ["system.run"] });
    let current = registerNodeSession(registry, first, pairing);
    if (change === "replacement") {
      current = registerNodeSession(
        registry,
        makeClient("conn-2", "node-1", [], { commands: ["system.run"] }),
        pairing,
      );
    } else if (change === "later generation") {
      registry.updateSurface("node-1", { commands: ["system.run"] }, transition);
    } else if (change === "different identity") {
      current = registerNodeSession(registry, first, { ...pairing, pairingIdentity: "identity-b" });
    } else {
      first.invalidated = true;
    }
    const before = {
      connId: current.connId,
      pairingIdentity: current.pairingIdentity,
      pairingGeneration: current.pairingGeneration,
      commands: current.commands,
      invalidated: current.client.invalidated,
    };

    expect(registry.updateSurface("node-1", { commands: [] }, transition)).toBeNull();
    expect({
      connId: current.connId,
      pairingIdentity: current.pairingIdentity,
      pairingGeneration: current.pairingGeneration,
      commands: current.commands,
      invalidated: current.client.invalidated,
    }).toEqual(before);
  },
);

it("refuses a stale approval notification before looking up current authority", async () => {
  const resolveCurrentPairingState = vi.fn(async () => ({
    identity: "identity-a",
    generation: "generation-b",
  }));
  const registry = createRegistry({ resolveCurrentPairingState });
  const frames: string[] = [];
  registerNodeSession(registry, makeClient("conn-1", "node-1", frames), {
    ...pairing,
    pairingGeneration: "generation-b",
  });
  const event = {
    nodeId: "node-1",
    connId: "conn-1",
    pairingIdentity: "identity-a",
    pairingGeneration: "generation-a",
    event: "node.pair.resolved",
    payload: { decision: "approved" },
  };

  await expect(registry.sendEventForPairingIdentity(event)).resolves.toBe(false);
  expect(resolveCurrentPairingState).not.toHaveBeenCalled();
  expect(frames).toEqual([]);
  await expect(
    registry.sendEventForPairingIdentity({ ...event, pairingGeneration: "generation-b" }),
  ).resolves.toBe(true);
  expect(frames).toHaveLength(1);
});

it("drops a prepared approval notification without invalidating a later live generation", async () => {
  const lookup = createDeferred<{ identity: string; generation: string }>();
  const registry = createRegistry({ resolveCurrentPairingState: () => lookup.promise });
  const frames: string[] = [];
  const client = makeClient("conn-1", "node-1", frames);
  registerNodeSession(registry, client, pairing);
  const sent = registry.sendEventForPairingIdentity({
    nodeId: "node-1",
    connId: "conn-1",
    pairingIdentity: "identity-a",
    pairingGeneration: "generation-a",
    event: "node.pair.resolved",
  });
  registry.updateSurface("node-1", { commands: [] }, transition);
  lookup.resolve({ identity: "identity-a", generation: "generation-b" });

  await expect(sent).resolves.toBe(false);
  expect(registry.get("node-1")?.pairingGeneration).toBe("generation-b");
  expect(client.invalidated).not.toBe(true);
  expect(frames).toEqual([]);
});
