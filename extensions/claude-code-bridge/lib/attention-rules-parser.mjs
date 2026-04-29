// Personal-attention synthesis parser + pattern matcher.
//
// Reads the latest `synthesis__bailey__cory-attention-rules-*.md` from the
// memory wiki, extracts the YAML block, and exposes a pattern-matcher that
// classifies an inbound email thread against sender/keyword/project tiers.
//
// Schema (v1):
//   schema_version: 1
//   sender_tiers:
//     critical: [regex, ...]
//     actionable: [regex, ...]
//     fyi: [regex, ...]
//     noise: [regex, ...]
//   keyword_tiers:
//     critical: [regex, ...]
//     actionable: [regex, ...]
//     fyi: [regex, ...]
//     noise: [regex, ...]
//   project_tags:
//     - tag: <slug>
//       keywords: [list]
//       severity: critical|actionable|fyi
//   escalation_rules:
//     idle_thread_days_threshold: 2
//     unread_count_critical: 5
//   confidence_threshold: 0.7
//   notes: |
//     Free-form context for LLM fallback.
//
// Kept JS-only on purpose: serve.mjs is plain ESM, the parser duplicates
// logic that lives in monorepo TS land (PR-3) but doesn't depend on it.
// Pattern severity ordering: critical > actionable > fyi > noise.
// First match wins per channel; channel scores combine via simple max.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const SEVERITIES = ["critical", "actionable", "fyi", "noise"];
const SEVERITY_RANK = { critical: 4, actionable: 3, fyi: 2, noise: 1 };

const DEFAULT_SYNTHESIS_DIR =
  process.env.OPENCLAW_BRIDGE_SYNTHESIS_DIR ??
  path.join(os.homedir(), ".openclaw", "wiki", "main", "synthesis", "main");

const SYNTHESIS_PREFIX = "synthesis__bailey__cory-attention-rules-";

const FENCED_YAML_RE = /```(?:ya?ml)?\s*\n([\s\S]*?)\n```/i;

// -- File discovery --------------------------------------------------------

/**
 * Find the newest synthesis file by dateKey suffix.
 * Returns the absolute path or null when nothing matches.
 */
export async function findLatestSynthesisFile(dirOverride) {
  const dir = dirOverride ?? DEFAULT_SYNTHESIS_DIR;
  let entries;
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }
  const candidates = entries
    .filter((name) => name.startsWith(SYNTHESIS_PREFIX) && name.endsWith(".md"))
    .toSorted()
    .toReversed();
  if (candidates.length === 0) {
    return null;
  }
  return path.join(dir, candidates[0]);
}

// -- Markdown / YAML parsing ----------------------------------------------

/**
 * Extract the first fenced YAML block from a markdown string and parse it
 * with a minimal hand-rolled YAML parser tailored to the schema above.
 * Returns null on any parse failure.
 */
export function parseSynthesisMarkdown(md) {
  if (typeof md !== "string" || md.length === 0) {
    return null;
  }
  const match = md.match(FENCED_YAML_RE);
  if (!match) {
    return null;
  }
  try {
    return parseAttentionYaml(match[1]);
  } catch {
    return null;
  }
}

/**
 * Hand-rolled YAML parser for the attention-rules schema. Supports:
 *   - top-level scalars (number, string, "|" multiline)
 *   - top-level maps with nested list-of-strings (sender_tiers, keyword_tiers)
 *   - top-level list of maps with nested list-of-strings (project_tags)
 *   - top-level map with scalar fields (escalation_rules)
 * Throws on unrecognized structures so the caller can fall back gracefully.
 */
export function parseAttentionYaml(yaml) {
  const lines = yaml.split(/\r?\n/);
  const out = {};
  let i = 0;

  function leadingSpaces(line) {
    const m = line.match(/^ */);
    return m ? m[0].length : 0;
  }
  function isBlank(line) {
    return /^\s*(#.*)?$/.test(line);
  }

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    const indent = leadingSpaces(line);
    if (indent !== 0) {
      // Stray indented line at top level — skip rather than crash
      i += 1;
      continue;
    }
    const m = line.match(/^([A-Za-z_][\w]*):\s*(.*)$/);
    if (!m) {
      throw new Error(`unexpected line: ${line}`);
    }
    const key = m[1];
    const rest = m[2].trim();
    if (rest === "|" || rest === ">") {
      // Block scalar: collect indented lines
      i += 1;
      const block = [];
      let blockIndent = null;
      while (i < lines.length) {
        const bl = lines[i];
        if (isBlank(bl) && blockIndent === null) {
          // leading blanks inside block — preserve as empty line
          block.push("");
          i += 1;
          continue;
        }
        const li = leadingSpaces(bl);
        if (li === 0 && bl.trim().length > 0) {
          break;
        }
        if (blockIndent === null && bl.trim().length > 0) {
          blockIndent = li;
        }
        const stripped =
          blockIndent !== null && bl.length >= blockIndent ? bl.slice(blockIndent) : bl.trim();
        block.push(stripped);
        i += 1;
      }
      out[key] = block.join("\n").replace(/\n+$/, "");
      continue;
    }
    if (rest.length > 0) {
      // Inline scalar value
      out[key] = parseScalar(rest);
      i += 1;
      continue;
    }
    // Empty value → either nested map or list. Peek at next non-blank line.
    let j = i + 1;
    while (j < lines.length && isBlank(lines[j])) {
      j += 1;
    }
    if (j >= lines.length) {
      out[key] = null;
      i = j;
      continue;
    }
    const next = lines[j];
    const nextIndent = leadingSpaces(next);
    if (nextIndent === 0) {
      out[key] = null;
      i = j;
      continue;
    }
    if (next.slice(nextIndent).startsWith("- ")) {
      // List of items (maps for project_tags, otherwise strings)
      const { items, consumed } = parseList(lines, j, nextIndent);
      out[key] = items;
      i = consumed;
      continue;
    }
    // Nested map
    const { obj, consumed } = parseMap(lines, j, nextIndent);
    out[key] = obj;
    i = consumed;
  }
  return out;
}

function parseScalar(raw) {
  const s = raw.trim();
  if (s === "" || s === "null" || s === "~") {
    return null;
  }
  if (s === "true") {
    return true;
  }
  if (s === "false") {
    return false;
  }
  if (/^-?\d+$/.test(s)) {
    return parseInt(s, 10);
  }
  if (/^-?\d*\.\d+$/.test(s)) {
    return parseFloat(s);
  }
  // Inline list — empty or otherwise — handled here so it's recognized
  // as a list rather than a string when it appears on the same line as
  // a key (e.g. "project_tags: []").
  if (s.startsWith("[") && s.endsWith("]")) {
    return parseInlineList(s) ?? [];
  }
  // Double-quoted: process YAML escapes. The schema only uses these for
  // regex patterns, so support the minimal set: \\ \" \n \t.
  if (s.startsWith('"') && s.endsWith('"')) {
    const inner = s.slice(1, -1);
    return inner.replace(/\\(.)/g, (_, ch) => {
      if (ch === "n") {
        return "\n";
      }
      if (ch === "t") {
        return "\t";
      }
      if (ch === "r") {
        return "\r";
      }
      // For \\ and \" and \. etc., \X becomes the next char (drops the slash
      // unless it's a known escape). This matches YAML 1.2 semantics for
      // unknown escapes — and importantly turns \\. into \., which is what
      // the regex layer expects.
      return ch;
    });
  }
  // Single-quoted: only doubled '' is an escape; everything else is literal.
  if (s.startsWith("'") && s.endsWith("'")) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}

function parseInlineList(raw) {
  // [a, b, "c, d"] — supports double-quoted entries with commas
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) {
    return null;
  }
  const inner = trimmed.slice(1, -1);
  const out = [];
  let buf = "";
  let inDouble = false;
  let inSingle = false;
  for (const ch of inner) {
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      buf += ch;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      buf += ch;
      continue;
    }
    if (ch === "," && !inDouble && !inSingle) {
      out.push(parseScalar(buf));
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim().length > 0) {
    out.push(parseScalar(buf));
  }
  return out;
}

function parseMap(lines, start, indent) {
  const obj = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*(#.*)?$/.test(line)) {
      i += 1;
      continue;
    }
    const ind = line.match(/^ */)[0].length;
    if (ind < indent) {
      break;
    }
    if (ind > indent) {
      // Skip stray over-indented lines
      i += 1;
      continue;
    }
    const m = line.slice(indent).match(/^([A-Za-z_][\w]*):\s*(.*)$/);
    if (!m) {
      break;
    }
    const key = m[1];
    const rest = m[2].trim();
    if (rest.startsWith("[")) {
      obj[key] = parseInlineList(rest) ?? [];
      i += 1;
      continue;
    }
    if (rest.length > 0) {
      obj[key] = parseScalar(rest);
      i += 1;
      continue;
    }
    // Nested list or map
    let j = i + 1;
    while (j < lines.length && /^\s*(#.*)?$/.test(lines[j])) {
      j += 1;
    }
    if (j >= lines.length) {
      obj[key] = null;
      i = j;
      continue;
    }
    const ni = lines[j].match(/^ */)[0].length;
    if (ni <= indent) {
      obj[key] = null;
      i = j;
      continue;
    }
    if (lines[j].slice(ni).startsWith("- ")) {
      const { items, consumed } = parseList(lines, j, ni);
      obj[key] = items;
      i = consumed;
      continue;
    }
    const { obj: nested, consumed } = parseMap(lines, j, ni);
    obj[key] = nested;
    i = consumed;
  }
  return { obj, consumed: i };
}

function parseList(lines, start, indent) {
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*(#.*)?$/.test(line)) {
      i += 1;
      continue;
    }
    const ind = line.match(/^ */)[0].length;
    if (ind < indent) {
      break;
    }
    if (ind > indent) {
      i += 1;
      continue;
    }
    const after = line.slice(indent);
    if (!after.startsWith("- ")) {
      break;
    }
    const itemText = after.slice(2);
    if (itemText.includes(":") && /^[A-Za-z_][\w]*:/.test(itemText)) {
      // List item is a map starting on this same line.
      // Synthesize a sub-block: re-indent the first key + collect deeper lines.
      const subLines = [itemText];
      let j = i + 1;
      while (j < lines.length) {
        const nxt = lines[j];
        if (/^\s*(#.*)?$/.test(nxt)) {
          j += 1;
          continue;
        }
        const ni = nxt.match(/^ */)[0].length;
        if (ni <= indent) {
          break;
        }
        // Strip indent + 2 (the "- " width) so keys line up at column 0
        subLines.push(nxt.slice(indent + 2));
        j += 1;
      }
      const { obj } = parseMap(subLines, 0, 0);
      items.push(obj);
      i = j;
      continue;
    }
    items.push(parseScalar(itemText));
    i += 1;
  }
  return { items, consumed: i };
}

// -- Public API for serve.mjs ---------------------------------------------

/**
 * Cache the parsed synthesis keyed by file path; invalidate when mtime
 * changes or after `ttlMs` elapses.
 */
const cache = {
  filePath: null,
  mtimeMs: 0,
  parsedAt: 0,
  rules: null,
};
const CACHE_TTL_MS = Number(process.env.OPENCLAW_BRIDGE_SYNTHESIS_CACHE_TTL_MS ?? "300000");

/**
 * Load the latest synthesis from disk, parse it, and return the rules
 * object. Returns null when the file is missing or malformed.
 */
export async function loadLatestSynthesis(opts = {}) {
  const dirOverride = opts.dir;
  const filePath = await findLatestSynthesisFile(dirOverride);
  if (!filePath) {
    return null;
  }
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return null;
  }
  const now = Date.now();
  const mtime = stat.mtimeMs;
  const cacheValid =
    cache.filePath === filePath &&
    cache.mtimeMs === mtime &&
    now - cache.parsedAt < CACHE_TTL_MS &&
    cache.rules !== null;
  if (cacheValid) {
    return { ...cache.rules, _filePath: filePath, _cached: true };
  }
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  const rules = parseSynthesisMarkdown(raw);
  if (!rules) {
    cache.filePath = filePath;
    cache.mtimeMs = mtime;
    cache.parsedAt = now;
    cache.rules = null;
    return null;
  }
  cache.filePath = filePath;
  cache.mtimeMs = mtime;
  cache.parsedAt = now;
  cache.rules = rules;
  return { ...rules, _filePath: filePath, _cached: false };
}

/** Reset the parser cache. Test helper. */
export function _resetSynthesisCache() {
  cache.filePath = null;
  cache.mtimeMs = 0;
  cache.parsedAt = 0;
  cache.rules = null;
}

// -- Pattern matcher ------------------------------------------------------

function compilePatterns(list) {
  if (!Array.isArray(list)) {
    return [];
  }
  const out = [];
  for (const raw of list) {
    if (typeof raw !== "string" || raw.length === 0) {
      continue;
    }
    try {
      out.push({ src: raw, re: new RegExp(raw, "i") });
    } catch {
      // Bad regex — skip silently rather than poison classification
    }
  }
  return out;
}

function bestSeverity(severityA, severityB) {
  if (!severityA) {
    return severityB;
  }
  if (!severityB) {
    return severityA;
  }
  return SEVERITY_RANK[severityA] >= SEVERITY_RANK[severityB] ? severityA : severityB;
}

/**
 * Pattern-match a thread against parsed rules.
 * Returns null when nothing matches (caller should escalate).
 * Otherwise: { severity, reason, confidence, matched: { sender?, keyword?, project? } }.
 */
export function classifyByPatterns(thread, rules) {
  if (!thread || !rules) {
    return null;
  }
  const fromValue = typeof thread.from === "string" ? thread.from : "";
  const subject = typeof thread.subject === "string" ? thread.subject : "";
  const snippet = typeof thread.snippet === "string" ? thread.snippet : "";
  const text = `${subject}\n${snippet}`;

  const matches = {};
  let severity = null;
  const reasons = [];

  // Sender tier — strongest signal, walk severities in descending order
  const senderTiers = rules.sender_tiers ?? {};
  for (const sev of SEVERITIES) {
    const compiled = compilePatterns(senderTiers[sev]);
    const hit = compiled.find((p) => p.re.test(fromValue));
    if (hit) {
      matches.sender = { severity: sev, pattern: hit.src };
      severity = bestSeverity(severity, sev);
      reasons.push(`sender matches ${sev} pattern /${hit.src}/`);
      break;
    }
  }

  // Keyword tier — check subject + snippet
  const keywordTiers = rules.keyword_tiers ?? {};
  for (const sev of SEVERITIES) {
    const compiled = compilePatterns(keywordTiers[sev]);
    const hit = compiled.find((p) => p.re.test(text));
    if (hit) {
      matches.keyword = { severity: sev, pattern: hit.src };
      severity = bestSeverity(severity, sev);
      reasons.push(`subject/snippet matches ${sev} keyword /${hit.src}/`);
      break;
    }
  }

  // Project tags — exact or substring match on tag.keywords
  const projectTags = Array.isArray(rules.project_tags) ? rules.project_tags : [];
  for (const tag of projectTags) {
    if (!tag || typeof tag !== "object") {
      continue;
    }
    const keywords = Array.isArray(tag.keywords) ? tag.keywords : [];
    const sev = typeof tag.severity === "string" ? tag.severity : null;
    if (!sev || !SEVERITIES.includes(sev)) {
      continue;
    }
    const lower = text.toLowerCase();
    const hit = keywords.find(
      (kw) => typeof kw === "string" && kw.length > 0 && lower.includes(kw.toLowerCase()),
    );
    if (hit) {
      matches.project = { tag: tag.tag, severity: sev, keyword: hit };
      severity = bestSeverity(severity, sev);
      reasons.push(`project tag '${tag.tag}' (${sev}) matched on '${hit}'`);
    }
  }

  if (!severity) {
    return null;
  }

  // Confidence: 0.95 when both sender + keyword agree on critical/actionable;
  // 0.85 when sender or keyword matched at the chosen severity; 0.7 otherwise.
  let confidence = 0.7;
  const matchSeverities = [
    matches.sender?.severity,
    matches.keyword?.severity,
    matches.project?.severity,
  ].filter(Boolean);
  if (matchSeverities.length >= 2 && matchSeverities.every((s) => s === severity)) {
    confidence = 0.95;
  } else if (matches.sender?.severity === severity || matches.keyword?.severity === severity) {
    confidence = 0.85;
  }

  return {
    severity,
    reason: reasons.join("; "),
    confidence,
    matched: matches,
  };
}
