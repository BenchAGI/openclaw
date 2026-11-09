import fs from "node:fs/promises";
import path from "node:path";
import { expect, test } from "vitest";
import type { CronService } from "../cron/service.js";
import { createCronCallerClient } from "./server-methods/cron.validation.test-support.js";
import type { GatewayClient } from "./server-methods/types.js";

/** Shares the existing Gateway cron suite's setup/cleanup and real SQLite service. */
export function registerCronCreationTests<
  State extends { cron: Pick<CronService, "list" | "readJob"> },
>(deps: {
  setupCronTestRun: () => Promise<{ dir: string }>;
  createDirectCronState: () => Promise<State>;
  directCronReq: (
    state: State,
    method: string,
    params: Record<string, unknown>,
    options?: { client?: GatewayClient },
  ) => Promise<{
    ok: boolean;
    payload?: unknown;
    error?: { code?: string; message?: string };
  }>;
  testState: { sessionStorePath?: string };
}) {
  const { setupCronTestRun, createDirectCronState, directCronReq, testState } = deps;
  test.each([false, true])(
    "null public scope retains caller/default ownership (scoped=%s)",
    async (scoped) => {
      await setupCronTestRun();
      const cronState = await createDirectCronState();
      const created = await directCronReq(
        cronState,
        "cron.add",
        {
          name: "nullable public scope",
          agentId: null,
          sessionKey: null,
          enabled: false,
          schedule: { kind: "every", everyMs: 60_000 },
          sessionTarget: "main",
          wakeMode: "next-heartbeat",
          payload: { kind: "systemEvent", text: "bounded fixture" },
        },
        scoped ? { client: createCronCallerClient("main") } : undefined,
      );
      expect(created.ok, JSON.stringify(created.error)).toBe(true);
      const job = await cronState.cron.readJob((created.payload as { id: string }).id);
      expect(job?.agentId).toBe(scoped ? "main" : undefined);
      expect(job?.sessionKey).toBeUndefined();
      expect(job?.owner?.agentId).toBe(scoped ? "main" : undefined);
      expect(job?.enabled).toBe(false);
    },
  );
  test("does not persist cron.add when the delivery preview cannot be resolved", async () => {
    const { dir } = await setupCronTestRun();
    testState.sessionStorePath = path.join(dir, "invalid.sqlite");
    await fs.writeFile(testState.sessionStorePath, "not a SQLite database");
    const cronState = await createDirectCronState();

    const response = await directCronReq(cronState, "cron.add", {
      name: "preview failure",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { kind: "agentTurn", message: "check status" },
    });

    expect(response.ok).toBe(false);
    expect(await cronState.cron.list({ includeDisabled: true })).toHaveLength(0);
  });

  test("cron.add honors create-only without changing default declaration convergence", async () => {
    await setupCronTestRun();
    const cronState = await createDirectCronState();
    const input = {
      name: "create-only original",
      declarationKey: "room:create-only",
      enabled: false,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "bounded fixture" },
    };
    const created = await directCronReq(cronState, "cron.add", { ...input, createOnly: true });
    expect(created.ok).toBe(true);
    const first = created.payload as { created: boolean; job: { id: string } };
    expect(first.created).toBe(true);
    expect(await cronState.cron.readJob(first.job.id)).not.toHaveProperty("createOnly");

    const conflict = await directCronReq(cronState, "cron.add", {
      ...input,
      displayName: "create-only replacement",
      createOnly: true,
    });
    expect(conflict.ok).toBe(false);
    expect(conflict.error?.code).toBe("INVALID_REQUEST");
    expect(conflict.error?.message).toContain("already exists within caller scope");
    expect(await cronState.cron.readJob(first.job.id)).toMatchObject({ name: input.name });
    const routineInput = Object.fromEntries(
      Object.entries(input).filter(([key]) => key !== "enabled"),
    );
    for (const createOnly of [undefined, false]) {
      const converged = await directCronReq(cronState, "cron.add", {
        ...routineInput,
        displayName: `default convergence ${String(createOnly)}`,
        ...(createOnly === undefined ? {} : { createOnly }),
      });
      expect(converged.ok).toBe(true);
      expect(converged.payload).toMatchObject({
        created: false,
        updated: true,
        job: { id: first.job.id },
      });
      expect((await cronState.cron.readJob(first.job.id))?.enabled).toBe(false);
    }
    expect(await cronState.cron.list({ includeDisabled: true })).toHaveLength(1);
  });
}
