// Public plugin-SDK surface for the governed Skill Workshop proposal lifecycle.
//
// The bench-sync fork plugin (extensions/bench-sync) enacts cloud operator
// decisions (apply / reject / quarantine) and mirrors proposal state up. It
// must reach the workshop service without importing the repo src/ tree
// directly (extension import boundary). This focused subpath exposes exactly
// the lifecycle functions + types that an extension needs — apply still
// re-runs the scanner internally, so enacting a decision here cannot bypass
// the security gate.

export {
  applySkillProposal,
  inspectSkillProposal,
  listSkillProposals,
  quarantineSkillProposal,
  rejectSkillProposal,
} from "../skills/workshop/service.js";

export type {
  SkillProposalActionInput,
  SkillProposalApplyResult,
  SkillProposalKind,
  SkillProposalManifest,
  SkillProposalManifestEntry,
  SkillProposalRecord,
  SkillProposalScan,
  SkillProposalScannerState,
  SkillProposalStatus,
  SkillProposalSupportFile,
} from "../skills/workshop/types.js";
