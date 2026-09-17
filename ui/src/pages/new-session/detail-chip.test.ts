import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import { renderDetailChip, renderWorktreeFields, resolveDetailChip } from "./detail-chip.ts";

describe("Detail chip state", () => {
  it("keeps automatic empty and selects unambiguous local or remote refs", () => {
    const container = document.createElement("div");
    const onBaseRefInput = vi.fn();
    render(
      renderWorktreeFields({
        branches: {
          repoRoot: "/repo",
          defaultBranch: "refs/remotes/origin/main",
          branches: [
            { name: "refs/heads/origin/main", kind: "local" },
            { name: "refs/remotes/origin/main", kind: "remote" },
          ],
        },
        branchesLoading: false,
        baseRef: "",
        worktreeName: "",
        submitting: false,
        pendingPlacement: false,
        onBaseRefInput,
        onWorktreeNameInput: () => undefined,
      }),
      container,
    );
    const input = container.querySelector<HTMLInputElement>('input[list="new-session-branches"]')!;
    const choices = Array.from(container.querySelectorAll<HTMLOptionElement>("datalist option"));
    expect(input.value).toBe("");
    expect(input.placeholder).toContain("Automatic");
    expect(choices.map(({ value, label }) => ({ value, label }))).toEqual([
      { value: "refs/heads/origin/main", label: "Local · origin/main" },
      { value: "refs/remotes/origin/main", label: "Remote · origin/main" },
    ]);
    for (const choice of choices) {
      input.value = choice.value;
      input.dispatchEvent(new Event("input"));
      expect(onBaseRefInput).toHaveBeenLastCalledWith(choice.value);
    }
    input.value = "";
    input.dispatchEvent(new Event("input"));
    expect(onBaseRefInput).toHaveBeenLastCalledWith("");
  });

  it.each([
    {
      name: "hides the detail chip for remote destinations",
      params: {
        destination: "remote" as const,
        worktree: false,
        worktreeAvailable: true,
      },
      expected: null,
    },
    {
      name: "hides the detail chip when local isolation is unavailable",
      params: {
        destination: "local" as const,
        worktree: false,
        worktreeAvailable: false,
      },
      expected: null,
    },
    {
      name: "shows the local isolation choice when it is available",
      params: {
        destination: "local" as const,
        worktree: false,
        worktreeAvailable: true,
      },
      expected: { label: "Runs directly" },
    },
  ])("$name", ({ params, expected }) => {
    expect(resolveDetailChip(params)).toEqual(expected);
  });

  it("keeps local isolation terminology as Worktree", () => {
    const container = document.createElement("div");
    render(
      renderDetailChip({
        state: { label: "Worktree" },
        worktree: true,
        worktreeAvailable: true,
        branches: { repoRoot: "/repo", branches: [] },
        branchesLoading: false,
        baseRef: "main",
        worktreeName: "",
        submitting: false,
        pendingPlacement: false,
        popoverOpen: true,
        popoverHiding: false,
        onGuardTransition: () => undefined,
        onPopoverShow: () => undefined,
        onPopoverHide: () => undefined,
        onPopoverAfterHide: () => undefined,
        onToggleWorktree: () => undefined,
        onBaseRefInput: () => undefined,
        onWorktreeNameInput: () => undefined,
      }),
      container,
    );

    const worktree = container.querySelector<HTMLButtonElement>('[data-value="worktree"]');
    expect(worktree?.disabled).toBe(false);
    expect(container.textContent).toContain("Worktree name");
  });
});
