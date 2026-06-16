/**
 * Hashline engine — hash-anchored line editing.
 *
 * Vendored & adapted from oh-my-pi (MIT, github.com/can1357/oh-my-pi).
 */

import * as XXH from "xxhashjs";
import { throwIfAborted } from "./runtime";

// ─── Types ──────────────────────────────────────────────────────────────

export type Anchor = { line: number; hash: string; textHint?: string };
export type HashlineEdit =
  | { op: "replace"; pos: Anchor; end?: Anchor; lines: string[] }
  | { op: "append"; pos?: Anchor; lines: string[] }
  | { op: "prepend"; pos?: Anchor; lines: string[] }
  | { op: "replace_text"; oldText: string; newText: string }
  | { op: "replace_regex"; pattern: string; replacement: string; expectedMatches?: number; flags?: string[] }
  | { op: "replace_dict"; mapping: Record<string, string> }
  | { op: "delete_lines"; pattern: string; condition: "contains" | "not_contains" | "matches"; expectedRemoved?: number }
  | { op: "insert_before"; marker: string; lines: string[]; occurrence?: number }
  | { op: "insert_after"; marker: string; lines: string[]; occurrence?: number }
  | { op: "delete_between"; startMarker: string; endMarker: string; occurrence?: number; inclusive?: boolean }
  | { op: "replace_block"; startMarker: string; endMarker: string; lines: string[]; occurrence?: number; inclusive?: boolean };

interface HashMismatch {
  line: number;
  expected: string;
  actual: string;
}

interface NoopEdit {
  editIndex: number;
  loc: string;
  currentContent: string;
}

// ─── Hash computation ───────────────────────────────────────────────────

/**
 * Custom 16-character hash alphabet. Deliberately excludes:
 * - Hex digits A–F (prevents confusion with hex literals in code)
 * - Visually confusable letters: D, G, I, L, O (look like digits 0, 6, 1, 1, 0)
 * - Common vowels A, E, I, O, U (prevents accidental English words)
 *
 * This makes hash references like "5#MQKT" unambiguous — they can never be
 * mistaken for code content, hex literals, or natural language.
 */
const NIBBLE_STR = "ZPMQVRWSNKTXJBYH";
const HASH_LENGTH = 4;
const HASH_ALPHABET_RE = new RegExp(`^[${NIBBLE_STR}]+$`);

/**
 * Patterns used to detect (and reject) hashline display prefixes inside edit
 * payloads. The runtime no longer strips them — the model must send literal
 * file content. Matching any of these triggers `[E_INVALID_PATCH]`.
 */
const HASHLINE_PREFIX_RE = new RegExp(
  `^\\s*(?:>>>|>>)?\\s*(?:\\d+\\s*#\\s*|#\\s*)[${NIBBLE_STR}]{${HASH_LENGTH}}:`,
);
const HASHLINE_PREFIX_PLUS_RE = new RegExp(
  `^\\+\\s*(?:\\d+\\s*#\\s*|#\\s*)[${NIBBLE_STR}]{${HASH_LENGTH}}:`,
);
const DIFF_MINUS_RE = /^-\s*\d+\s{4}/;

/** Lines containing no alphanumeric characters (only punctuation/symbols/whitespace). */
const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;

function xxh32(input: string, seed = 0): number {
  return XXH.h32(seed).update(input).digest().toNumber() >>> 0;
}

export function computeLineHash(idx: number, line: string): string {
  line = line.replace(/\r/g, "").trimEnd();
  let seed = 0;
  if (!RE_SIGNIFICANT.test(line)) {
    seed = idx;
  }
  const value = xxh32(line, seed) & 0xffff;
  return Array.from(
    { length: HASH_LENGTH },
    (_, index) => NIBBLE_STR[(value >>> ((HASH_LENGTH - index - 1) * 4)) & 0x0f],
  ).join("");
}

/** Shared fuzzy-match Unicode replacement regexes (also used by edit-diff.ts). */
export const FUZZY_SINGLE_QUOTES_RE = /[\u2018\u2019\u201A\u201B]/g;
export const FUZZY_DOUBLE_QUOTES_RE = /[\u201C\u201D\u201E\u201F]/g;
export const FUZZY_HYPHENS_RE = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g;
export const FUZZY_UNICODE_SPACES_RE = /[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g;

function normalizeFuzzyLine(text: string): string {
  return text
    .trimEnd()
    .replace(FUZZY_SINGLE_QUOTES_RE, "'")
    .replace(FUZZY_DOUBLE_QUOTES_RE, '"')
    .replace(FUZZY_HYPHENS_RE, "-")
    .replace(FUZZY_UNICODE_SPACES_RE, " ");
}

function isFuzzyEquivalentLine(expected: string, actual: string): boolean {
  return normalizeFuzzyLine(expected) === normalizeFuzzyLine(actual);
}

// ─── Parsing ────────────────────────────────────────────────────────────

function diagnoseLineRef(ref: string): string {
  const trimmed = ref.trim();
  const core = ref.replace(/^\s*[>+-]*\s*/, "").trim();

  if (!core.length) {
    return `[E_BAD_REF] Invalid line reference "${ref}". Expected "LINE#HASH" (e.g. "5#MQKT").`;
  }
  if (/^\d+\s*$/.test(core)) {
    return `[E_BAD_REF] Invalid line reference "${ref}": missing hash, use "LINE#HASH" from read output (e.g. "5#MQKT").`;
  }
  if (/^\d+\s*:/.test(core)) {
    return `[E_BAD_REF] Invalid line reference "${ref}": wrong separator, use "LINE#HASH" instead of "LINE:...".`;
  }

  const hashMatch = core.match(/^(\d+)\s*#\s*([^\s:]+)(?:\s*:.*)?$/);
  if (hashMatch) {
    const line = Number.parseInt(hashMatch[1]!, 10);
    const hash = hashMatch[2]!;
    if (line < 1) {
      return `[E_BAD_REF] Line number must be >= 1, got ${line} in "${ref}".`;
    }
    if (hash.length !== HASH_LENGTH) {
      return `[E_BAD_REF] Invalid line reference "${ref}": hash must be exactly ${HASH_LENGTH} characters from ${NIBBLE_STR}.`;
    }
    if (!HASH_ALPHABET_RE.test(hash)) {
      return `[E_BAD_REF] Invalid line reference "${ref}": hash uses invalid characters, hashes use alphabet ${NIBBLE_STR} only.`;
    }
  }

  const missingHashMatch = core.match(/^(\d+)\s*#\s*$/);
  if (missingHashMatch) {
    return `[E_BAD_REF] Invalid line reference "${ref}": missing hash after "#", use "LINE#HASH" from read output.`;
  }

  if (/^0+\s*#/.test(core)) {
    return `[E_BAD_REF] Line number must be >= 1, got 0 in "${ref}".`;
  }

  return `[E_BAD_REF] Invalid line reference "${trimmed || ref}". Expected "LINE#HASH" (e.g. "5#MQKT").`;
}

export function parseLineRef(ref: string): { line: number; hash: string } {
  // Match LINE#HASH format, tolerating:
  //  - leading ">+" and whitespace (from mismatch/diff display)
  //  - optional trailing display suffix (":..." content)
  const parsed = parseAnchorRef(ref);
  return { line: parsed.line, hash: parsed.hash };
}

function parseAnchorRef(ref: string): Anchor {
  const core = ref.replace(/^\s*[>+-]*\s*/, "").trimEnd();
  const match = core.match(/^([0-9]+)\s*#\s*([^\s:]+)(?:\s*:(.*))?$/s);
  if (!match) {
    throw new Error(diagnoseLineRef(ref));
  }

  const line = Number.parseInt(match[1]!, 10);
  if (line < 1) {
    throw new Error(`[E_BAD_REF] Line number must be >= 1, got ${line} in "${ref}".`);
  }

  const hash = match[2]!;
  if (hash.length !== HASH_LENGTH) {
    throw new Error(`[E_BAD_REF] Invalid line reference "${ref}": hash must be exactly ${HASH_LENGTH} characters from ${NIBBLE_STR}.`);
  }

  if (!HASH_ALPHABET_RE.test(hash)) {
    throw new Error(
      `[E_BAD_REF] Invalid line reference "${ref}": hash uses invalid characters, hashes use alphabet ${NIBBLE_STR} only.`,
    );
  }

  const textHint = match[3];
  return {
    line,
    hash,
    ...(textHint !== undefined ? { textHint } : {}),
  };
}

// ─── Mismatch formatting ────────────────────────────────────────────────

function formatMismatchError(
  mismatches: HashMismatch[],
  fileLines: string[],
  retryLines: ReadonlySet<number> = new Set<number>(),
): string {
  const retryLineSet = new Set<number>(retryLines);
  for (const m of mismatches) {
    retryLineSet.add(m.line);
  }

  const displayLines = new Set<number>();
  for (const m of mismatches) {
    for (
      let i = Math.max(1, m.line - 2);
      i <= Math.min(fileLines.length, m.line + 2);
      i++
    ) {
      displayLines.add(i);
    }
  }
  for (const line of retryLineSet) {
    displayLines.add(line);
  }

  const sorted = [...displayLines].sort((a, b) => a - b);
  const maxDisplayLine = sorted[sorted.length - 1] ?? 1;
  const lineNumberWidth = String(maxDisplayLine).length;
  const out: string[] = [
    `[E_STALE_ANCHOR] ${mismatches.length} stale anchor${mismatches.length > 1 ? "s" : ""}. Retry with the >>> LINE#HASH lines below; keep both endpoints for range replaces.`,
    "",
  ];

  let prev = -1;
  for (const num of sorted) {
    if (prev !== -1 && num > prev + 1) out.push("    ...");
    prev = num;
    const content = fileLines[num - 1];
    const hash = computeLineHash(num, content);
    const prefix = `${String(num).padStart(lineNumberWidth, " ")}#${hash}`;
    out.push(
      retryLineSet.has(num)
        ? `>>> ${prefix}:${content}`
        : `    ${prefix}:${content}`,
    );
  }

  return out.join("\n");
}

// ─── Content preprocessing ─────────────────────────────────────────────────────

/**
 * Reject hashline display prefixes in edit payloads. Strict semantics: the
 * model must send literal file content for `lines`, not the rendered read /
 * diff form. Silent stripping is no longer performed — see AGENTS.md.
 */
function assertNoDisplayPrefixes(lines: string[]): void {
  for (const line of lines) {
    if (!line.length) continue;
    if (
      HASHLINE_PREFIX_RE.test(line) ||
      HASHLINE_PREFIX_PLUS_RE.test(line) ||
      DIFF_MINUS_RE.test(line)
    ) {
      throw new Error(
        `[E_INVALID_PATCH] "lines" must contain literal file content, not rendered "LINE#HASH:" or diff "+/-" prefixes. Offending line: ${JSON.stringify(line)}`,
      );
    }
  }
}

/**
 * Parse replacement text into lines.
 *
 * String input is normalized to LF and drops exactly one trailing newline,
 * matching read-preview style content. Array input is preserved verbatim so
 * explicitly provided blank lines remain intact. Display prefixes are
 * rejected by `assertNoDisplayPrefixes`, never silently stripped.
 */
export function hashlineParseText(edit: string[] | string | null): string[] {
  if (edit === null) return [];
  const lines = typeof edit === "string"
    ? (edit.endsWith("\n") ? edit.slice(0, -1) : edit).replaceAll("\r", "").split("\n")
    : edit;
  assertNoDisplayPrefixes(lines);
  return lines;
}

/**
 * Map flat tool-schema edits into typed internal representations.
 *
 * Strict: provided anchors must parse successfully. Missing anchors are
 * fine for append (→ EOF) and prepend (→ BOF), but a malformed anchor
 * that was explicitly supplied is always an error.
 *
 * - replace + pos only → single-line replace
 * - replace + pos + end → range replace
 * - append + pos → append after that anchor
 * - prepend + pos → prepend before that anchor
 * - replace_text + oldText/newText → exact unique text replace
 * - no anchors → file-level append/prepend (only for those ops)
 *
 * Unknown or missing ops are rejected explicitly.
 */
export function resolveEditAnchors(edits: HashlineToolEdit[]): HashlineEdit[] {
  const result: HashlineEdit[] = [];
  const VALID_OPS = new Set([
    "replace", "append", "prepend", "replace_text",
    "replace_regex", "replace_dict", "delete_lines",
    "insert_before", "insert_after", "delete_between", "replace_block",
  ]);
  for (const edit of edits) {
    const op = edit.op;
    if (!VALID_OPS.has(op)) {
      throw new Error(
        `[E_BAD_OP] Unknown edit op "${op}". Expected one of: ${[...VALID_OPS].join(", ")}.`,
      );
    }

    switch (op) {
      case "replace": {
        if (!edit.pos) {
          throw new Error('[E_BAD_OP] Replace requires a "pos" anchor.');
        }
        result.push({
          op: "replace",
          pos: parseAnchorRef(edit.pos),
          ...(edit.end ? { end: parseAnchorRef(edit.end) } : {}),
          lines: hashlineParseText(edit.lines ?? null),
        });
        break;
      }
      case "append": {
        if (edit.end !== undefined) {
          throw new Error('[E_BAD_OP] Append does not support "end". Use "pos" or omit it for EOF.');
        }
        result.push({
          op: "append",
          ...(edit.pos ? { pos: parseAnchorRef(edit.pos) } : {}),
          lines: hashlineParseText(edit.lines ?? null),
        });
        break;
      }
      case "prepend": {
        if (edit.end !== undefined) {
          throw new Error('[E_BAD_OP] Prepend does not support "end". Use "pos" or omit it for BOF.');
        }
        result.push({
          op: "prepend",
          ...(edit.pos ? { pos: parseAnchorRef(edit.pos) } : {}),
          lines: hashlineParseText(edit.lines ?? null),
        });
        break;
      }
      case "replace_text": {
        const oldText = normalizeExactText(edit.oldText);
        const newText = normalizeExactText(edit.newText);
        if (oldText === undefined || newText === undefined) {
          throw new Error('[E_BAD_OP] replace_text requires string "oldText" and "newText" fields.');
        }
        result.push({
          op: "replace_text",
          oldText,
          newText,
        });
        break;
      }
      case "replace_regex": {
        if (typeof edit.pattern !== "string" || typeof edit.replacement !== "string") {
          throw new Error('[E_BAD_OP] replace_regex requires string "pattern" and "replacement".');
        }
        result.push({
          op: "replace_regex",
          pattern: edit.pattern,
          replacement: normalizeExactText(edit.replacement) ?? edit.replacement,
          expectedMatches: edit.expectedMatches ?? 1,
          ...(edit.flags ? { flags: edit.flags } : {}),
        });
        break;
      }
      case "replace_dict": {
        if (typeof edit.mapping !== "object" || edit.mapping === null) {
          throw new Error('[E_BAD_OP] replace_dict requires a "mapping" object of {old: new} pairs.');
        }
        const normalized: Record<string, string> = {};
        for (const [key, value] of Object.entries(edit.mapping)) {
          if (typeof value !== "string") {
            throw new Error(`[E_BAD_OP] replace_dict mapping value for "${key}" must be a string.`);
          }
          normalized[normalizeExactText(key) ?? key] = normalizeExactText(value) ?? value;
        }
        result.push({ op: "replace_dict", mapping: normalized });
        break;
      }
      case "delete_lines": {
        if (typeof edit.pattern !== "string") {
          throw new Error('[E_BAD_OP] delete_lines requires a string "pattern".');
        }
        const condition = edit.condition ?? "contains";
        if (condition !== "contains" && condition !== "not_contains" && condition !== "matches") {
          throw new Error('[E_BAD_OP] delete_lines "condition" must be "contains", "not_contains", or "matches".');
        }
        result.push({
          op: "delete_lines",
          pattern: edit.pattern,
          condition,
          ...(edit.expectedRemoved !== undefined ? { expectedRemoved: edit.expectedRemoved } : {}),
        });
        break;
      }
      case "insert_before":
      case "insert_after": {
        if (typeof edit.marker !== "string" || edit.marker.length === 0) {
          throw new Error(`[E_BAD_OP] ${op} requires a non-empty string "marker".`);
        }
        const marker = normalizeExactText(edit.marker) ?? edit.marker;
        const lines = hashlineParseText(edit.lines ?? null);
        if (lines.length === 0) {
          throw new Error(`[E_BAD_OP] ${op} requires non-empty "lines".`);
        }
        result.push({
          op: op as "insert_before" | "insert_after",
          marker,
          lines,
          occurrence: edit.occurrence ?? 1,
        });
        break;
      }
      case "delete_between": {
        if (typeof edit.startMarker !== "string" || typeof edit.endMarker !== "string") {
          throw new Error('[E_BAD_OP] delete_between requires string "startMarker" and "endMarker".');
        }
        result.push({
          op: "delete_between",
          startMarker: normalizeExactText(edit.startMarker) ?? edit.startMarker,
          endMarker: normalizeExactText(edit.endMarker) ?? edit.endMarker,
          occurrence: edit.occurrence ?? 1,
          inclusive: edit.inclusive ?? false,
        });
        break;
      }
      case "replace_block": {
        if (typeof edit.startMarker !== "string" || typeof edit.endMarker !== "string") {
          throw new Error('[E_BAD_OP] replace_block requires string "startMarker" and "endMarker".');
        }
        const lines = hashlineParseText(edit.lines ?? null);
        if (lines.length === 0) {
          throw new Error('[E_BAD_OP] replace_block requires non-empty "lines".');
        }
        result.push({
          op: "replace_block",
          startMarker: normalizeExactText(edit.startMarker) ?? edit.startMarker,
          endMarker: normalizeExactText(edit.endMarker) ?? edit.endMarker,
          lines,
          occurrence: edit.occurrence ?? 1,
          inclusive: edit.inclusive ?? false,
        });
        break;
      }
    }
  }
  return result;
}

// ─── Main edit engine ───────────────────────────────────────────────────

/** Schema-level edit as received from the tool layer (pos/end are tag strings, lines may be string|null). */
export type HashlineToolEdit = {
  op: string;
  path?: string;
  pos?: string;
  end?: string;
  lines?: string[] | string | null;
  oldText?: string;
  newText?: string;
  // replace_regex
  pattern?: string;
  replacement?: string;
  expectedMatches?: number;
  flags?: string[];
  // replace_dict
  mapping?: Record<string, string>;
  // delete_lines
  condition?: "contains" | "not_contains" | "matches";
  expectedRemoved?: number;
  // insert_before / insert_after
  marker?: string;
  occurrence?: number;
  // delete_between / replace_block
  startMarker?: string;
  endMarker?: string;
  inclusive?: boolean;
};

function normalizeExactText(text: string | undefined): string | undefined {
  if (typeof text !== "string") {
    return undefined;
  }

  return text.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function maybeWarnSuspiciousUnicodeEscapePlaceholder(
  edits: HashlineEdit[],
  warnings: string[],
): void {
  for (const edit of edits) {
    if (
      edit.op === "replace_text" ||
      edit.op === "replace_regex" ||
      edit.op === "replace_dict" ||
      edit.op === "delete_lines" ||
      edit.op === "delete_between"
    ) {
      continue;
    }
    if (edit.lines.some((line) => /\\uDDDD/i.test(line))) {
      warnings.push(
        "Detected literal \\uDDDD in edit content; no autocorrection applied. Verify whether this should be a real Unicode escape or plain text.",
      );
    }
  }
}

type ResolvedEditSpan = {
  kind: "replace" | "insert";
  index: number;
  label: string;
  start: number;
  end: number;
  replacement: string;
  boundary?: number;
  insertMode?: "append-empty-origin" | "prepend-empty-origin";
};

type LineIndex = {
  fileLines: string[];
  lineStarts: number[];
  hasTerminalNewline: boolean;
};

function buildLineIndex(content: string): LineIndex {
  const fileLines = content.split("\n");
  const lineStarts: number[] = [];
  let offset = 0;

  for (let index = 0; index < fileLines.length; index++) {
    lineStarts.push(offset);
    offset += fileLines[index]!.length;
    if (index < fileLines.length - 1) {
      offset += 1;
    }
  }

  return {
    fileLines,
    lineStarts,
    hasTerminalNewline: content.endsWith("\n"),
  };
}

function previewText(text: string): string {
  const compact = text.replaceAll("\n", "\\n");
  return compact.length > 32 ? `${compact.slice(0, 29)}...` : compact;
}

function describeEdit(edit: HashlineEdit): string {
  switch (edit.op) {
    case "replace":
      return edit.end
        ? `replace ${edit.pos.line}#${edit.pos.hash}-${edit.end.line}#${edit.end.hash}`
        : `replace ${edit.pos.line}#${edit.pos.hash}`;
    case "append":
      return edit.pos
        ? `append after ${edit.pos.line}#${edit.pos.hash}`
        : "append at EOF";
    case "prepend":
      return edit.pos
        ? `prepend before ${edit.pos.line}#${edit.pos.hash}`
        : "prepend at BOF";
    case "replace_text":
      return `replace_text \"${previewText(edit.oldText)}\"`;
    case "replace_regex":
      return `replace_regex /${previewText(edit.pattern)}/`;
    case "replace_dict":
      return `replace_dict (${Object.keys(edit.mapping).length} keys)`;
    case "delete_lines":
      return `delete_lines ${edit.condition} \"${previewText(edit.pattern)}\"`;
    case "insert_before":
      return `insert_before \"${previewText(edit.marker)}\"`;
    case "insert_after":
      return `insert_after \"${previewText(edit.marker)}\"`;
    case "delete_between":
      return `delete_between \"${previewText(edit.startMarker)}\"..\"${previewText(edit.endMarker)}\"`;
    case "replace_block":
      return `replace_block \"${previewText(edit.startMarker)}\"..\"${previewText(edit.endMarker)}\"`;
  }
}

function throwEditConflict(
  left: { index: number; label: string },
  right: { index: number; label: string },
  reason: string,
): never {
  throw new Error(
    `[E_EDIT_CONFLICT] Conflicting edits in a single request: edit ${left.index} (${left.label}) and edit ${right.index} (${right.label}) ${reason}. Merge them into one non-overlapping change or split the request.`,
  );
}

function cloneHashlineEdit(edit: HashlineEdit): HashlineEdit {
  switch (edit.op) {
    case "replace":
      return {
        op: "replace",
        pos: { ...edit.pos },
        ...(edit.end ? { end: { ...edit.end } } : {}),
        lines: [...edit.lines],
      };
    case "append":
      return {
        op: "append",
        ...(edit.pos ? { pos: { ...edit.pos } } : {}),
        lines: [...edit.lines],
      };
    case "prepend":
      return {
        op: "prepend",
        ...(edit.pos ? { pos: { ...edit.pos } } : {}),
        lines: [...edit.lines],
      };
    case "replace_text":
      return {
        op: "replace_text",
        oldText: edit.oldText,
        newText: edit.newText,
      };
    case "replace_regex":
      return {
        op: "replace_regex",
        pattern: edit.pattern,
        replacement: edit.replacement,
        expectedMatches: edit.expectedMatches,
        ...(edit.flags ? { flags: [...edit.flags] } : {}),
      };
    case "replace_dict":
      return {
        op: "replace_dict",
        mapping: { ...edit.mapping },
      };
    case "delete_lines":
      return {
        op: "delete_lines",
        pattern: edit.pattern,
        condition: edit.condition,
        ...(edit.expectedRemoved !== undefined ? { expectedRemoved: edit.expectedRemoved } : {}),
      };
    case "insert_before":
    case "insert_after":
      return {
        op: edit.op,
        marker: edit.marker,
        lines: [...edit.lines],
        occurrence: edit.occurrence,
      };
    case "delete_between":
      return {
        op: "delete_between",
        startMarker: edit.startMarker,
        endMarker: edit.endMarker,
        occurrence: edit.occurrence,
        inclusive: edit.inclusive,
      };
    case "replace_block":
      return {
        op: "replace_block",
        startMarker: edit.startMarker,
        endMarker: edit.endMarker,
        lines: [...edit.lines],
        occurrence: edit.occurrence,
        inclusive: edit.inclusive,
      };
  }
}

function computeInsertionBoundary(
  edit: Extract<HashlineEdit, { op: "append" | "prepend" }>,
  lineIndex: LineIndex,
): number {
  switch (edit.op) {
    case "append": {
      const fileLineCount = lineIndex.fileLines.length;
      const eofBoundary = lineIndex.hasTerminalNewline && fileLineCount > 0
        ? fileLineCount - 1
        : fileLineCount;
      return edit.pos
        ? lineIndex.hasTerminalNewline && edit.pos.line === fileLineCount
          ? eofBoundary
          : edit.pos.line
        : eofBoundary;
    }
    case "prepend":
      return edit.pos ? edit.pos.line - 1 : 0;
  }
}

function findExactUniqueTextMatch(
  content: string,
  oldText: string,
): { start: number; end: number } {
  if (oldText.length === 0) {
    throw new Error("[E_BAD_OP] replace_text requires non-empty oldText.");
  }

  const matches: number[] = [];
  let from = 0;
  while (from <= content.length - oldText.length) {
    const index = content.indexOf(oldText, from);
    if (index === -1) {
      break;
    }
    matches.push(index);
    from = index + 1;
  }

  for (let index = 1; index < matches.length; index++) {
    if (matches[index]! - matches[index - 1]! < oldText.length) {
      throw new Error(
        "[E_MULTI_MATCH] replace_text found overlapping exact matches; re-read and use hashline edits.",
      );
    }
  }

  if (matches.length === 0) {
    throw new Error("[E_NO_MATCH] replace_text found no exact unique match in the current file.");
  }

  if (matches.length > 1) {
    throw new Error(
      "[E_MULTI_MATCH] replace_text found multiple exact matches in the current file. Re-read and use hashline edits.",
    );
  }

  const start = matches[0]!;
  return {
    start,
    end: start + oldText.length,
  };
}

/**
 * Count exact occurrences of a substring in content.
 */
function countOccurrences(content: string, search: string): number {
  if (search.length === 0) return 0;
  let count = 0;
  let from = 0;
  while (from <= content.length - search.length) {
    const idx = content.indexOf(search, from);
    if (idx === -1) break;
    count++;
    from = idx + 1;
  }
  return count;
}

/**
 * Find the first character position where old and new content differ.
 */
function findFirstDiff(oldContent: string, newContent: string): number {
  const minLen = Math.min(oldContent.length, newContent.length);
  for (let i = 0; i < minLen; i++) {
    if (oldContent[i] !== newContent[i]) return i;
  }
  return minLen;
}

/**
 * Find the last differing span between old and new content.
 */
function findLastDiff(oldContent: string, newContent: string): { end: number; endInNew: number } {
  let oldIdx = oldContent.length - 1;
  let newIdx = newContent.length - 1;
  const firstDiff = findFirstDiff(oldContent, newContent);
  while (oldIdx >= firstDiff && newIdx >= firstDiff && oldContent[oldIdx] === newContent[newIdx]) {
    oldIdx--;
    newIdx--;
  }
  return { end: oldIdx + 1, endInNew: newIdx + 1 };
}

/**
 * Find the Nth occurrence of marker text in content.
 */
function findMarkerOccurrence(
  content: string,
  marker: string,
  occurrence: number,
  opLabel: string,
): { start: number; end: number } {
  if (marker.length === 0) {
    throw new Error(`[E_BAD_OP] ${opLabel} requires non-empty marker.`);
  }
  const positions: number[] = [];
  let from = 0;
  while (from <= content.length - marker.length) {
    const idx = content.indexOf(marker, from);
    if (idx === -1) break;
    positions.push(idx);
    from = idx + 1;
  }
  if (positions.length === 0) {
    throw new Error(`[E_NO_MATCH] ${opLabel}: marker not found in file.`);
  }
  if (occurrence > positions.length) {
    throw new Error(`[E_NO_MATCH] ${opLabel}: requested occurrence ${occurrence} but marker found ${positions.length} time(s).`);
  }
  if (occurrence === 1 && positions.length > 1) {
    throw new Error(`[E_MULTI_MATCH] ${opLabel}: marker appears ${positions.length} times. Specify "occurrence" or make marker more specific.`);
  }
  const idx = positions[occurrence - 1]!;
  return { start: idx, end: idx + marker.length };
}

/**
 * Find the span between startMarker and endMarker (occurrence-th pair).
 */
function findBetweenMarkers(
  content: string,
  startMarker: string,
  endMarker: string,
  occurrence: number,
  opLabel: string,
  inclusive: boolean,
): { start: number; end: number } {
  if (startMarker.length === 0 || endMarker.length === 0) {
    throw new Error(`[E_BAD_OP] ${opLabel} requires non-empty markers.`);
  }
  // Find all start positions
  const starts: number[] = [];
  let from = 0;
  while (from <= content.length - startMarker.length) {
    const idx = content.indexOf(startMarker, from);
    if (idx === -1) break;
    starts.push(idx);
    from = idx + 1;
  }
  if (starts.length === 0) {
    throw new Error(`[E_NO_MATCH] ${opLabel}: startMarker not found.`);
  }
  if (occurrence > starts.length) {
    throw new Error(`[E_NO_MATCH] ${opLabel}: occurrence ${occurrence} but startMarker found ${starts.length} time(s).`);
  }
  const startPos = starts[occurrence - 1]!;
  const searchFrom = startPos + startMarker.length;
  const endIdx = content.indexOf(endMarker, searchFrom);
  if (endIdx === -1) {
    throw new Error(`[E_NO_MATCH] ${opLabel}: endMarker not found after startMarker.`);
  }
  // Strict uniqueness: reject if startMarker appears again before endMarker
  const nextStart = content.indexOf(startMarker, searchFrom);
  if (nextStart !== -1 && nextStart < endIdx) {
    throw new Error(`[E_MULTI_MATCH] ${opLabel}: startMarker appears again before endMarker. Markers must have a unique pair.`);
  }
  // Also reject if endMarker appears again before any next startMarker
  const nextEndAfter = content.indexOf(endMarker, endIdx + endMarker.length);
  if (nextEndAfter !== -1 && (nextStart === -1 || nextEndAfter < nextStart)) {
    throw new Error(`[E_MULTI_MATCH] ${opLabel}: endMarker appears again before the next startMarker. Ambiguous pair. Make markers more specific or use occurrence.`);
  }
  if (inclusive) {
    return { start: startPos, end: endIdx + endMarker.length };
  }
  return { start: startPos + startMarker.length, end: endIdx };
}

function resolveEditToSpan(
  edit: HashlineEdit,
  index: number,
  content: string,
  lineIndex: LineIndex,
  noopEdits: NoopEdit[],
): ResolvedEditSpan | null {
  const { fileLines, lineStarts, hasTerminalNewline } = lineIndex;

  switch (edit.op) {
    case "replace": {
      const startLine = edit.pos.line;
      const endLine = edit.end?.line ?? edit.pos.line;
      const originalLines = fileLines.slice(startLine - 1, endLine);
      if (
        originalLines.length === edit.lines.length &&
        originalLines.every((line, lineIndex) => line === edit.lines[lineIndex])
      ) {
        noopEdits.push({
          editIndex: index,
          loc: `${edit.pos.line}#${edit.pos.hash}`,
          currentContent: originalLines.join("\n"),
        });
        return null;
      }

      if (edit.lines.length > 0) {
        return {
          kind: "replace",
          index,
          label: describeEdit(edit),
          start: lineStarts[startLine - 1]!,
          end: lineStarts[endLine - 1]! + fileLines[endLine - 1]!.length,
          replacement: edit.lines.join("\n"),
        };
      }

      if (startLine === 1 && endLine === fileLines.length) {
        return {
          kind: "replace",
          index,
          label: describeEdit(edit),
          start: 0,
          end: content.length,
          replacement: "",
        };
      }

      if (endLine < fileLines.length) {
        return {
          kind: "replace",
          index,
          label: describeEdit(edit),
          start: lineStarts[startLine - 1]!,
          end: lineStarts[endLine]!,
          replacement: "",
        };
      }

      return {
        kind: "replace",
        index,
        label: describeEdit(edit),
        start: Math.max(0, lineStarts[startLine - 1]! - 1),
        end: lineStarts[endLine - 1]! + fileLines[endLine - 1]!.length,
        replacement: "",
      };
    }
    case "append": {
      if (edit.lines.length === 0) {
        noopEdits.push({
          editIndex: index,
          loc: edit.pos ? `${edit.pos.line}#${edit.pos.hash}` : "EOF",
          currentContent: edit.pos ? fileLines[edit.pos.line - 1] ?? "" : "",
        });
        return null;
      }

      const insertedText = edit.lines.join("\n");
      if (content.length === 0) {
        return {
          kind: "insert",
          index,
          label: describeEdit(edit),
          start: 0,
          end: 0,
          replacement: insertedText,
          boundary: computeInsertionBoundary(edit, lineIndex),
          insertMode: "append-empty-origin",
        };
      }

      if (!edit.pos) {
        return {
          kind: "insert",
          index,
          label: describeEdit(edit),
          start: content.length,
          end: content.length,
          replacement: hasTerminalNewline ? `${insertedText}\n` : `\n${insertedText}`,
          boundary: computeInsertionBoundary(edit, lineIndex),
        };
      }

      const isSentinelAppend = hasTerminalNewline && edit.pos.line === fileLines.length;
      return {
        kind: "insert",
        index,
        label: describeEdit(edit),
        start: isSentinelAppend
          ? content.length
          : lineStarts[edit.pos.line - 1]! + fileLines[edit.pos.line - 1]!.length,
        end: isSentinelAppend
          ? content.length
          : lineStarts[edit.pos.line - 1]! + fileLines[edit.pos.line - 1]!.length,
        replacement: isSentinelAppend ? `${insertedText}\n` : `\n${insertedText}`,
        boundary: computeInsertionBoundary(edit, lineIndex),
      };
    }
    case "prepend": {
      if (edit.lines.length === 0) {
        noopEdits.push({
          editIndex: index,
          loc: edit.pos ? `${edit.pos.line}#${edit.pos.hash}` : "BOF",
          currentContent: edit.pos ? fileLines[edit.pos.line - 1] ?? "" : "",
        });
        return null;
      }

      const insertedText = edit.lines.join("\n");
      const start = edit.pos ? lineStarts[edit.pos.line - 1]! : 0;
      return {
        kind: "insert",
        index,
        label: describeEdit(edit),
        start,
        end: start,
        replacement: content.length === 0 ? insertedText : `${insertedText}\n`,
        boundary: computeInsertionBoundary(edit, lineIndex),
        ...(content.length === 0 ? { insertMode: "prepend-empty-origin" as const } : {}),
      };
    }
    case "replace_text": {
      const match = findExactUniqueTextMatch(content, edit.oldText);
      if (edit.oldText === edit.newText) {
        noopEdits.push({
          editIndex: index,
          loc: `replace_text \"${previewText(edit.oldText)}\"`,
          currentContent: edit.oldText,
        });
        return null;
      }
      return {
        kind: "replace",
        index,
        label: describeEdit(edit),
        start: match.start,
        end: match.end,
        replacement: edit.newText,
      };
    }
    case "replace_regex": {
      if (edit.pattern.length === 0) {
        throw new Error("[E_BAD_OP] replace_regex requires non-empty pattern.");
      }
      let reFlags = "g";
      if (edit.flags) {
        if (edit.flags.includes("case_insensitive")) reFlags += "i";
        if (edit.flags.includes("multiline")) reFlags += "m";
        if (edit.flags.includes("dotall")) reFlags += "s";
      }
      const regex = new RegExp(edit.pattern, reFlags);
      const matches = [...content.matchAll(regex)];
      const expected = edit.expectedMatches ?? 1;
      if (matches.length === 0) {
        throw new Error(`[E_NO_MATCH] replace_regex: pattern had no matches.`);
      }
      if (expected === 1 && matches.length > 1) {
        throw new Error(`[E_MULTI_MATCH] replace_regex: pattern matched ${matches.length} times. Make pattern more specific, use "global" flag, or set expectedMatches.`);
      }
      if (expected > 0 && matches.length !== expected) {
        throw new Error(`[E_MULTI_MATCH] replace_regex: expected ${expected} match(es), got ${matches.length}.`);
      }
      const newContent = content.replace(regex, edit.replacement);
      if (newContent === content) {
        noopEdits.push({
          editIndex: index,
          loc: `replace_regex /${previewText(edit.pattern)}/`,
          currentContent: `(no change)`,
        });
        return null;
      }
      const firstDiff = findFirstDiff(content, newContent);
      const lastDiff = findLastDiff(content, newContent);
      return {
        kind: "replace",
        index,
        label: describeEdit(edit),
        start: firstDiff,
        end: lastDiff.end,
        replacement: newContent.slice(firstDiff, lastDiff.endInNew),
      };
    }
    case "replace_dict": {
      const entries = Object.entries(edit.mapping);
      if (entries.length === 0) {
        throw new Error("[E_BAD_OP] replace_dict requires a non-empty mapping.");
      }
      // Phase 1: validate ALL keys against ORIGINAL content (not cascaded)
      const spans: Array<{ start: number; end: number; replacement: string }> = [];
      for (const [oldStr, newStr] of entries) {
        if (oldStr.length === 0) {
          throw new Error("[E_BAD_OP] replace_dict keys must be non-empty strings.");
        }
        const count = countOccurrences(content, oldStr);
        if (count === 0) {
          throw new Error(`[E_NO_MATCH] replace_dict: "${previewText(oldStr)}" not found.`);
        }
        if (count > 1) {
          throw new Error(`[E_MULTI_MATCH] replace_dict: "${previewText(oldStr)}" appears ${count} times. Each key must match exactly once.`);
        }
        if (oldStr === newStr) continue;
        const idx = content.indexOf(oldStr);
        spans.push({ start: idx, end: idx + oldStr.length, replacement: newStr });
      }
      if (spans.length === 0) {
        noopEdits.push({
          editIndex: index,
          loc: `replace_dict (${entries.length} keys)`,
          currentContent: "(all no-ops)",
        });
        return null;
      }
      // Phase 2: check for overlapping spans
      spans.sort((a, b) => a.start - b.start);
      for (let i = 1; i < spans.length; i++) {
        if (spans[i]!.start < spans[i - 1]!.end) {
          throw new Error("[E_EDIT_CONFLICT] replace_dict: overlapping replacements detected. Merge them or split into separate edits.");
        }
      }
      // Phase 3: apply bottom-up
      let newContent = content;
      for (let i = spans.length - 1; i >= 0; i--) {
        const s = spans[i]!;
        newContent = newContent.slice(0, s.start) + s.replacement + newContent.slice(s.end);
      }
      const firstDiff = findFirstDiff(content, newContent);
      const lastDiff = findLastDiff(content, newContent);
      return {
        kind: "replace",
        index,
        label: describeEdit(edit),
        start: firstDiff,
        end: lastDiff.end,
        replacement: newContent.slice(firstDiff, lastDiff.endInNew),
      };
    }
    case "delete_lines": {
      if (edit.pattern.length === 0) {
        throw new Error("[E_BAD_OP] delete_lines requires a non-empty pattern.");
      }
      const lines = content.split("\n");
      const keep: boolean[] = new Array(lines.length).fill(true);
      let removed = 0;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        let shouldRemove = false;
        switch (edit.condition) {
          case "contains": shouldRemove = line.includes(edit.pattern); break;
          case "not_contains": shouldRemove = !line.includes(edit.pattern); break;
          case "matches": shouldRemove = new RegExp(edit.pattern).test(line); break;
        }
        if (shouldRemove) { keep[i] = false; removed++; }
      }
      if (edit.expectedRemoved !== undefined && removed !== edit.expectedRemoved) {
        throw new Error(`delete_lines: expected ${edit.expectedRemoved} removed, got ${removed}.`);
      }
      if (removed === 0) {
        noopEdits.push({
          editIndex: index,
          loc: `delete_lines ${edit.condition} "${previewText(edit.pattern)}"`,
          currentContent: "(no matching lines)",
        });
        return null;
      }
      // Build replacement: span from first removed line start to last removed line end,
      // preserving line separators between kept lines within the span.
      let firstRemoved = -1, lastRemoved = -1;
      for (let i = 0; i < keep.length; i++) {
        if (!keep[i]) { if (firstRemoved === -1) firstRemoved = i; lastRemoved = i; }
      }
      const lsIdx = buildLineIndex(content);
      const spanStart = lsIdx.lineStarts[firstRemoved]!;
      // End of span: after last removed line (including its newline if not at EOF)
      const hasNewlineAfter = lastRemoved < lines.length - 1 || content.endsWith("\n");
      const spanEnd = lsIdx.lineStarts[lastRemoved]! + lines[lastRemoved]!.length + (hasNewlineAfter ? 1 : 0);
      // Build replacement from original content slice, keeping only non-removed lines
      const originalSpan = content.slice(spanStart, spanEnd);
      const spanLines = originalSpan.split("\n");
      // Restore the trailing empty string if originalSpan ends with newline
      const hasTrailingNewline = originalSpan.endsWith("\n");
      const keptSpanLines = spanLines.filter((_, i) => {
        const globalIdx = firstRemoved + i;
        return globalIdx <= lastRemoved && keep[globalIdx];
      });
      const replacement = keptSpanLines.join("\n") + (hasTrailingNewline && keptSpanLines.length > 0 ? "\n" : "");
      return {
        kind: "replace",
        index,
        label: describeEdit(edit),
        start: spanStart,
        end: spanEnd,
        replacement,
      };
    }
    case "insert_before":
    case "insert_after": {
      const markerMatch = findMarkerOccurrence(content, edit.marker, edit.occurrence, edit.op);
      const insertedText = edit.lines.join("\n");
      const pos = edit.op === "insert_before" ? markerMatch.start : markerMatch.end;
      const before = content.slice(0, pos);
      const after = content.slice(pos);
      const needsLeadingNewline = before.length > 0 && !before.endsWith("\n");
      const needsTrailingNewline = after.length > 0 && !after.startsWith("\n");
      const replacement = (needsLeadingNewline ? "\n" : "") + insertedText + (needsTrailingNewline ? "\n" : "");
      return {
        kind: "insert",
        index,
        label: describeEdit(edit),
        start: pos,
        end: pos,
        replacement,
        boundary: pos,
      };
    }
    case "delete_between": {
      const span = findBetweenMarkers(content, edit.startMarker, edit.endMarker, edit.occurrence, "delete_between", edit.inclusive);
      if (span.start >= span.end) {
        noopEdits.push({
          editIndex: index,
          loc: `delete_between "${previewText(edit.startMarker)}".."${previewText(edit.endMarker)}"`,
          currentContent: "(empty span)",
        });
        return null;
      }
      return {
        kind: "replace",
        index,
        label: describeEdit(edit),
        start: span.start,
        end: span.end,
        replacement: "",
      };
    }
    case "replace_block": {
      const span = findBetweenMarkers(content, edit.startMarker, edit.endMarker, edit.occurrence, "replace_block", edit.inclusive);
      const replacement = edit.lines.join("\n");
      if (content.slice(span.start, span.end) === replacement) {
        noopEdits.push({
          editIndex: index,
          loc: `replace_block "${previewText(edit.startMarker)}".."${previewText(edit.endMarker)}"`,
          currentContent: "(already matches)",
        });
        return null;
      }
      return {
        kind: "replace",
        index,
        label: describeEdit(edit),
        start: span.start,
        end: span.end,
        replacement,
      };
    }
  }
}

function assertNoConflictingSpans(spans: ResolvedEditSpan[]): void {
  for (let leftIndex = 0; leftIndex < spans.length; leftIndex++) {
    const left = spans[leftIndex]!;
    for (let rightIndex = leftIndex + 1; rightIndex < spans.length; rightIndex++) {
      const right = spans[rightIndex]!;

      if (left.kind === "insert" && right.kind === "insert") {
        if (left.boundary === right.boundary) {
          throwEditConflict(left, right, "target the same insertion boundary");
        }
        continue;
      }

      if (left.kind === "replace" && right.kind === "replace") {
        if (left.start < right.end && right.start < left.end) {
          throwEditConflict(left, right, "overlap on the same original line range");
        }
        continue;
      }

      const replaceSpan = left.kind === "replace" ? left : right;
      const insertSpan = left.kind === "insert" ? left : right;
      if (insertSpan.start >= replaceSpan.start && insertSpan.start < replaceSpan.end) {
        throwEditConflict(
          left,
          right,
          "cannot be applied together because one inserts inside a replaced original range",
        );
      }
    }
  }
}

export function applyHashlineEdits(
  content: string,
  edits: HashlineEdit[],
  signal?: AbortSignal,
): {
  content: string;
  firstChangedLine: number | undefined;
  lastChangedLine: number | undefined;
  warnings?: string[];
  noopEdits?: NoopEdit[];
} {
  throwIfAborted(signal);
  if (!edits.length) return { content, firstChangedLine: undefined, lastChangedLine: undefined };

  const workingEdits = edits.map(cloneHashlineEdit);
  const lineIndex = buildLineIndex(content);
  const noopEdits: NoopEdit[] = [];
  const warnings: string[] = [];

  const mismatches: HashMismatch[] = [];
  const retryLines = new Set<number>();
  const acceptedFuzzyRefs = new Set<string>();
  function validate(ref: Anchor): boolean {
    if (ref.line < 1 || ref.line > lineIndex.fileLines.length) {
      throw new Error(`[E_RANGE_OOB] Line ${ref.line} does not exist (file has ${lineIndex.fileLines.length} lines)`);
    }
    const line = lineIndex.fileLines[ref.line - 1]!;
    const actual = computeLineHash(ref.line, line);
    if (actual === ref.hash) return true;
    if (ref.textHint !== undefined) {
      const hintedHash = computeLineHash(ref.line, ref.textHint);
      if (hintedHash === ref.hash && isFuzzyEquivalentLine(ref.textHint, line)) {
        const key = `${ref.line}:${ref.hash}:${ref.textHint}`;
        if (!acceptedFuzzyRefs.has(key)) {
          acceptedFuzzyRefs.add(key);
          warnings.push(
            `Accepted fuzzy anchor validation at line ${ref.line}: exact hash mismatched, but the copied line content still matched after whitespace/Unicode normalization.`,
          );
        }
        return true;
      }
    }
    mismatches.push({ line: ref.line, expected: ref.hash, actual });
    retryLines.add(ref.line);
    return false;
  }

  for (const edit of workingEdits) {
    throwIfAborted(signal);
    switch (edit.op) {
      case "replace": {
        if (edit.end) {
          if (edit.pos.line > edit.end.line) {
            throw new Error(
              `[E_BAD_OP] Range start line ${edit.pos.line} must be <= end line ${edit.end.line}`,
            );
          }
          const startOk = validate(edit.pos);
          const endOk = validate(edit.end);
          if (!startOk && endOk) {
            retryLines.add(edit.end.line);
          }
          if (startOk && !endOk) {
            retryLines.add(edit.pos.line);
          }
          if (!startOk || !endOk) continue;
        } else if (!validate(edit.pos)) {
          continue;
        }
        const endLine = edit.end?.line ?? edit.pos.line;
        const nextLine = lineIndex.fileLines[endLine];
        const replacementLastLine = edit.lines.at(-1)?.trim();
        if (
          nextLine !== undefined &&
          replacementLastLine &&
          RE_SIGNIFICANT.test(replacementLastLine) &&
          replacementLastLine === nextLine.trim()
        ) {
          warnings.push(
            `Potential boundary duplication after ${describeEdit(edit)}: the replacement ends with a line that matches the next surviving line after trim.`,
          );
        }
        break;
      }
      case "append": {
        if (edit.pos && !validate(edit.pos)) continue;
        if (edit.lines.length === 0) {
          throw new Error(
            "[E_BAD_OP] Append with empty lines payload. Provide content to insert or remove the edit.",
          );
        }
        break;
      }
      case "prepend": {
        if (edit.pos && !validate(edit.pos)) continue;
        if (edit.lines.length === 0) {
          throw new Error(
            "[E_BAD_OP] Prepend with empty lines payload. Provide content to insert or remove the edit.",
          );
        }
        break;
      }
      case "replace_text":
      case "replace_regex":
      case "replace_dict":
      case "delete_lines":
      case "insert_before":
      case "insert_after":
      case "delete_between":
      case "replace_block":
        break;
    }
  }
  if (mismatches.length) {
    throw new Error(formatMismatchError(mismatches, lineIndex.fileLines, retryLines));
  }

  maybeWarnSuspiciousUnicodeEscapePlaceholder(workingEdits, warnings);

  const seenSpanKeys = new Set<string>();
  const resolvedSpans: ResolvedEditSpan[] = [];
  for (const [index, edit] of workingEdits.entries()) {
    throwIfAborted(signal);
    const span = resolveEditToSpan(edit, index, content, lineIndex, noopEdits);
    if (!span) {
      continue;
    }

    const spanKey = span.kind === "insert"
      ? `insert:${span.boundary}:${span.replacement}`
      : `replace:${span.start}:${span.end}:${span.replacement}`;
    if (seenSpanKeys.has(spanKey)) {
      continue;
    }
    seenSpanKeys.add(spanKey);
    resolvedSpans.push(span);
  }

  assertNoConflictingSpans(resolvedSpans);

  const orderedSpans = [...resolvedSpans].sort((left, right) => {
    if (right.end !== left.end) {
      return right.end - left.end;
    }
    if (left.kind !== right.kind) {
      return left.kind === "replace" ? -1 : 1;
    }
    if (left.kind === "insert" && right.kind === "insert") {
      return (right.boundary ?? -1) - (left.boundary ?? -1) || left.index - right.index;
    }
    return left.index - right.index;
  });

  let result = content;
  for (const span of orderedSpans) {
    throwIfAborted(signal);
    const replacement = span.insertMode === "append-empty-origin"
      ? result.length === 0
        ? span.replacement
        : `\n${span.replacement}`
      : span.insertMode === "prepend-empty-origin"
        ? result.length === 0
          ? span.replacement
          : `${span.replacement}\n`
        : span.replacement;
    result = result.slice(0, span.start) + replacement + result.slice(span.end);
  }

  const changedRange = computeLegacyEditLineRange(content, result);
  return {
    content: result,
    firstChangedLine: changedRange?.firstChangedLine,
    lastChangedLine: changedRange?.lastChangedLine,
    ...(warnings.length ? { warnings } : {}),
    ...(noopEdits.length ? { noopEdits } : {}),
  };
}

// ─── Affected-line computation (for returning anchors after edit) ───────

const ANCHOR_CONTEXT_LINES = 2;
const ANCHOR_MAX_OUTPUT_LINES = 12;

/**
 * Compute the post-edit line range covering changed lines plus context.
 * Uses `firstChangedLine` and `lastChangedLine` from the edit result for
 * precise bounds. Returns null if the range (with context) exceeds the
 * output budget, signalling that the LLM should re-read instead.
 */
export function computeAffectedLineRange(params: {
  firstChangedLine: number | undefined;
  lastChangedLine: number | undefined;
  resultLineCount: number;
  contextLines?: number;
  maxOutputLines?: number;
}): { start: number; end: number } | null {
  const {
    firstChangedLine,
    lastChangedLine,
    resultLineCount,
    contextLines = ANCHOR_CONTEXT_LINES,
    maxOutputLines = ANCHOR_MAX_OUTPUT_LINES,
  } = params;

  if (firstChangedLine === undefined || lastChangedLine === undefined) {
    return null;
  }

  // Empty file after edit: no meaningful anchor block.
  if (resultLineCount === 0) {
    return null;
  }

  const start = Math.max(1, firstChangedLine - contextLines);
  const end = Math.min(resultLineCount, lastChangedLine + contextLines);

  // Guard against inverted range (can happen when context pushes end below start).
  if (end < start) {
    return null;
  }

  if (end - start + 1 > maxOutputLines) {
    return null;
  }

  return { start, end };
}

export function formatHashlineRegion(
  lines: string[],
  startLine: number,
): string {
  const lineNumberWidth = String(
    startLine + Math.max(0, lines.length - 1),
  ).length;
  return lines
    .map((line, index) => {
      const lineNumber = startLine + index;
      const paddedLineNumber = String(lineNumber).padStart(lineNumberWidth, " ");
      return `${paddedLineNumber}#${computeLineHash(lineNumber, line)}:${line}`;
    })
    .join("\n");
}

// ─── Legacy edit line range computation ─────────────────────────────

/**
 * Compute first/last changed line numbers for legacy (oldText/newText) edits.
 * Uses character-level diff to locate the changed span, then maps to line
 * numbers in the result document so downstream anchor chaining works.
 */
export function computeLegacyEditLineRange(
  original: string,
  result: string,
): { firstChangedLine: number; lastChangedLine: number } | null {
  if (original === result) return null;

  function countVisibleLines(text: string): number {
    if (text.length === 0) {
      return 0;
    }
    const lines = text.split("\n");
    return text.endsWith("\n") ? lines.length - 1 : lines.length;
  }

  if (original.length === 0) {
    return {
      firstChangedLine: 1,
      lastChangedLine: countVisibleLines(result),
    };
  }

  if (result.startsWith(original) && original.endsWith("\n")) {
    return {
      firstChangedLine: countVisibleLines(original) + 1,
      lastChangedLine: countVisibleLines(result),
    };
  }

  let firstDiff = 0;
  const minLen = Math.min(original.length, result.length);
  while (firstDiff < minLen && original[firstDiff] === result[firstDiff]) {
    firstDiff++;
  }
  if (firstDiff === minLen && original.length === result.length) return null;

  let lastOrig = original.length - 1;
  let lastRes = result.length - 1;
  while (
    lastOrig >= firstDiff &&
    lastRes >= firstDiff &&
    original[lastOrig] === result[lastRes]
  ) {
    lastOrig--;
    lastRes--;
  }

  function indexToLine(charIdx: number, text: string): number {
    let line = 1;
    for (let i = 0; i < charIdx && i < text.length; i++) {
      if (text[i] === "\n") line++;
    }
    return line;
  }

  const firstChangedLine = indexToLine(firstDiff + 1, result);
  let lastChangedLine: number;
  if (lastRes < firstDiff) {
    lastChangedLine = result.length === 0 ? 1 : countVisibleLines(result);
  } else if (firstDiff === 0 && original.length > 0 && result.endsWith(original)) {
    lastChangedLine = firstChangedLine;
  } else {
    lastChangedLine = indexToLine(lastRes + 1, result);
  }

  return { firstChangedLine, lastChangedLine };
}
