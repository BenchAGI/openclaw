// The BenchAGI/openclaw fork ships one customer build of the Control UI. This
// flag names the surfaces that differ from upstream on purpose, so a reviewer
// can find every gate from one place:
//   - identity menu + About links point at benchagi.com (§3, BENCH_LINKS)
//   - the upstream community invite card never renders (§5 ruling 2026-09-06:
//     an OpenClaw Discord invite inside a customer's Vault is a brand defect)
export const BENCH_CUSTOMER_BUILD = true;
