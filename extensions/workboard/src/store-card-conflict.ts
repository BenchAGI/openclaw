import type { WorkboardCard } from "@openclaw/workboard-contract";

export class WorkboardCardConflictError extends Error {
  constructor(readonly current: WorkboardCard) {
    super("Card changed while you were editing. Review the latest values and retry.");
    this.name = "WorkboardCardConflictError";
  }
}
