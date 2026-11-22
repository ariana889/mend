// main.ts is mend, the CLI SPEC.md specifies (MIT). It reads an edit an AI model wrote in any of four formats —
// a unified diff, SEARCH/REPLACE blocks, a V4A patch, or text-editor tool calls as JSON — finds the lines the
// edit names even when their whitespace or indentation drifted (SPEC.md section 5), and changes every file or
// none. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): that hand-over and runner.ts stay as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/* ---------- files as lines (SPEC.md section 3) ---------- */

interface FileLines {
  lines: string[];
  br: string;
  fin: boolean;
}

function splitFile(text: string): FileLines {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  let fin = false;
  if (text.endsWith(br)) {
    parts.pop();
    fin = true;
  }
  return { lines: parts, br, fin };
}

function joinFile(fl: FileLines): string {
  if (fl.lines.length === 0) return '';
  return fl.lines.join(fl.br) + (fl.fin ? fl.br : '');
}

/* ---------- matching lines (SPEC.md section 5) ---------- */

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWS = (s: string): string => /^[ \t]*/.exec(s)![0]!;

function cmpLine(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Every start position at or after `from` where O's lines match at `tier`; occurrences may overlap. */
function occAt(lines: string[], O: string[], tier: number, from = 0): number[] {
  const res: number[] = [];
  for (let i = from; i + O.length <= lines.length; i += 1) {
    let ok = true;
    for (let k = 0; k < O.length; k += 1) {
      if (!cmpLine(lines[i + k]!, O[k]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) res.push(i);
  }
  return res;
}

function findMatch(lines: string[], O: string[], strict: boolean): { tier: number; occ: number[] } | null {
  for (const t of tiers(strict)) {
    const occ = occAt(lines, O, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

interface NEnt {
  text: string;
  ctx: boolean;
  oi: number; // for a context entry, its index in O
}

/** The lines to write for a match of O at `at`: context lines are the file's own; at tier 2 the rest re-indent. */
function buildWritten(fileLines: string[], at: number, O: string[], N: NEnt[], tier: number): string[] {
  const F = leadWS(fileLines[at] ?? '');
  const P = O.length > 0 ? leadWS(O[0]!) : '';
  return N.map((e) => {
    if (e.ctx) return fileLines[at + e.oi]!;
    if (tier === 2) {
      const s = e.text;
      if (s !== '' && s.trim() !== '' && s.startsWith(P)) return F + s.slice(P.length);
      return s;
    }
    return e.text;
  });
}

interface BodyLine {
  kind: ' ' | '-' | '+';
  text: string;
}

/** O and N of a hunk or chunk body, each in body order. */
function bodyON(body: BodyLine[]): { O: string[]; N: NEnt[] } {
  const O: string[] = [];
  const N: NEnt[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      O.push(b.text);
      N.push({ text: b.text, ctx: true, oi: O.length - 1 });
    } else if (b.kind === '-') O.push(b.text);
    else N.push({ text: b.text, ctx: false, oi: -1 });
  }
  return { O, N };
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/* ---------- JSON edits (SPEC.md section 9) ---------- */

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const fl = splitFile(before);
      if (line < 0 || line > fl.lines.length) throw new Fail('no-match', p);
      fl.lines.splice(line, 0, ...add);
      tree.now.set(p, joinFile(fl));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/* ---------- unified diffs (SPEC.md section 6) ---------- */

interface UHunk {
  A: number;
  body: BodyLine[];
  /** Indices of body entries a `\` line follows. */
  backslash: Set<number>;
}

interface USec {
  gitOld: string | null;
  gitNew: string | null;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  hunks: UHunk[];
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function headerPath(text: string): string {
  const tab = text.indexOf('\t');
  const raw = (tab >= 0 ? text.slice(0, tab) : text).trim();
  return raw.startsWith('a/') || raw.startsWith('b/') ? raw.slice(2) : raw;
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const secs: USec[] = [];
  let cur: USec | null = null;
  let body: BodyLine[] | null = null;
  let backslash = new Set<number>();
  let hunkA = 0;

  const endBody = (): void => {
    if (cur !== null && body !== null) {
      while (body.length > 0 && body[body.length - 1]!.kind === ' ' && body[body.length - 1]!.text === '' && (body[body.length - 1] as { empty?: boolean }).empty) body.pop();
      cur.hunks.push({ A: hunkA, body, backslash });
    }
    body = null;
    backslash = new Set<number>();
  };
  const newSec = (): USec => {
    endBody();
    const s: USec = { gitOld: null, gitNew: null, pairOld: null, pairNew: null, renameFrom: null, renameTo: null, newFile: false, delFile: false, hunks: [] };
    secs.push(s);
    cur = s;
    return s;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const L = lines[i]!;
    const lineNo = i + 1;
    const next = lines[i + 1] ?? '';
    const startsPair = L.startsWith('--- ') && next.startsWith('+++ ');
    const startsGit = L.startsWith('diff --git ');

    if (body !== null) {
      if (startsGit || startsPair || HUNK_RE.test(L)) {
        endBody(); // fall through and read the line as a header or a new hunk
      } else if (L.startsWith('@@')) {
        throw new Exit2(`error: parse ${lineNo}`);
      } else if (L === '') {
        body.push({ kind: ' ', text: '', ...( { empty: true } as object) } as BodyLine);
        continue;
      } else if (L[0] === ' ' || L[0] === '-' || L[0] === '+') {
        body.push({ kind: L[0] as BodyLine['kind'], text: L.slice(1) });
        continue;
      } else if (L[0] === '\\') {
        if (body.length > 0) backslash.add(body.length - 1);
        continue;
      } else {
        endBody(); // fall through and read the line outside the body
      }
    }

    if (startsGit) {
      const m = /^a\/(.+) b\/(.+)$/.exec(L.slice('diff --git '.length));
      if (m === null) throw new Exit2(`error: parse ${lineNo}`);
      const s = newSec();
      s.gitOld = m[1]!;
      s.gitNew = m[2]!;
      continue;
    }
    if (startsPair) {
      if (cur === null || cur.pairOld !== null || cur.hunks.length > 0) newSec();
      cur!.pairOld = headerPath(L.slice(4));
      cur!.pairNew = headerPath(next.slice(4));
      i += 1;
      continue;
    }
    if (HUNK_RE.test(L)) {
      if (cur === null) throw new Exit2(`error: parse ${lineNo}`);
      hunkA = Number(HUNK_RE.exec(L)![1]);
      body = [];
      backslash = new Set<number>();
      continue;
    }
    if (L.startsWith('@@')) throw new Exit2(`error: parse ${lineNo}`);
    if (cur !== null && cur.hunks.length === 0 && body === null) {
      // A section header: the lines before its first hunk.
      if (L.startsWith('--- ')) throw new Exit2(`error: parse ${lineNo + 1}`);
      if (L.startsWith('rename from ')) cur.renameFrom = L.slice('rename from '.length).trim();
      else if (L.startsWith('rename to ')) cur.renameTo = L.slice('rename to '.length).trim();
      else if (L.startsWith('new file mode')) cur.newFile = true;
      else if (L.startsWith('deleted file mode')) cur.delFile = true;
    }
    // Anything else, in or out of a section, is ignored.
  }
  endBody();

  const edits: Edit[] = [];
  for (const s of secs) {
    const oldP = s.pairOld ?? s.renameFrom ?? s.gitOld;
    const newP = s.pairNew ?? s.renameTo ?? s.gitNew;
    edits.push(unifiedEdit(s, oldP, newP, strict));
  }
  return edits;
}

function unifiedEdit(s: USec, oldP: string | null, newP: string | null, strict: boolean): Edit {
  const isCreate = oldP === '/dev/null' || s.newFile;
  const isDelete = newP === '/dev/null' || s.delFile;
  return (tree) => {
    if (isCreate) {
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastPlus = -1;
      let lastPlusSlash = false;
      let order = 0;
      for (const h of s.hunks) {
        h.body.forEach((b, bi) => {
          if (b.kind === '+') {
            plus.push(b.text);
            lastPlus = order;
            lastPlusSlash = h.backslash.has(bi);
          }
          order += 1;
        });
      }
      void lastPlus;
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (lastPlusSlash ? '' : '\n'));
      return;
    }
    const o = oldP!;
    if (!safe(o)) throw new Fail('unsafe', o);
    if (isDelete) {
      if (tree.get(o) === null) throw new Fail('missing', o);
      tree.now.set(o, null);
      return;
    }
    const n = newP!;
    if (!safe(n)) throw new Fail('unsafe', n);
    const before = tree.get(o);
    if (before === null) throw new Fail('missing', o);
    const isMove = n !== o;
    if (isMove && tree.get(n) !== null) throw new Fail('exists', n);
    const fl = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      const { O, N } = bodyON(h.body);
      const lastNewSide = (() => {
        for (let k = h.body.length - 1; k >= 0; k -= 1) {
          if (h.body[k]!.kind !== '-') return h.backslash.has(k);
        }
        return false;
      })();
      if (O.length === 0) {
        const at = Math.min(h.A + d, fl.lines.length);
        const atEnd = at === fl.lines.length;
        const written = N.map((e) => e.text);
        fl.lines.splice(at, 0, ...written);
        if (atEnd && written.length > 0) fl.fin = !lastNewSide;
        d += written.length;
        continue;
      }
      const m = findMatch(fl.lines, O, strict);
      if (m === null) throw new Fail('no-match', o);
      const target = h.A - 1 + d;
      let best = m.occ[0]!;
      for (const p of m.occ) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const written = buildWritten(fl.lines, best, O, N, m.tier);
      const atEnd = best + O.length === fl.lines.length;
      fl.lines.splice(best, O.length, ...written);
      if (atEnd) fl.fin = !lastNewSide;
      d += N.length - O.length;
    }
    const out = joinFile(fl);
    if (isMove) {
      tree.now.set(n, out);
      tree.now.set(o, null);
      tree.moves.push([o, n]);
    } else {
      tree.now.set(o, out);
    }
  };
}

/* ---------- SEARCH/REPLACE blocks (SPEC.md section 7) ---------- */

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    old: string[];
    neu: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let i = 0;
  for (;;) {
    let s = -1;
    for (let j = i; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j -= 1) {
      const L = lines[j]!;
      if (blank(L)) continue;
      if (L.trim().startsWith('```')) continue;
      path = L.trim();
      break;
    }
    if (path === null) {
      if (blocks.length === 0) throw new Exit2(`error: parse ${s + 1}`);
      path = blocks[blocks.length - 1]!.path;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, old: lines.slice(s + 1, eq), neu: lines.slice(eq + 1, rep) });
    prevEnd = rep;
    i = rep + 1;
  }
  return blocks.map(
    (b): Edit =>
      (tree) => {
        if (!safe(b.path)) throw new Fail('unsafe', b.path);
        if (b.old.length === 0) {
          if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
          tree.now.set(b.path, b.neu.length === 0 ? '' : b.neu.join('\n') + '\n');
          return;
        }
        const before = tree.get(b.path);
        if (before === null) throw new Fail('missing', b.path);
        const fl = splitFile(before);
        const m = findMatch(fl.lines, b.old, strict);
        if (m === null) throw new Fail('no-match', b.path);
        if (m.occ.length > 1) throw new Fail('ambiguous', b.path);
        const at = m.occ[0]!;
        const written = buildWritten(
          fl.lines,
          at,
          b.old,
          b.neu.map((t) => ({ text: t, ctx: false, oi: -1 })),
          m.tier,
        );
        fl.lines.splice(at, b.old.length, ...written);
        tree.now.set(b.path, joinFile(fl));
      },
  );
}

/* ---------- V4A patches (SPEC.md section 8) ---------- */

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = lines.length - 1; j >= 0; j -= 1) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const HEADERS: [string, string][] = [
    ['*** Add File: ', 'add'],
    ['*** Delete File: ', 'del'],
    ['*** Update File: ', 'upd'],
  ];
  const headerOf = (L: string): [string, string] | null => {
    for (const [pre, kind] of HEADERS) if (L.startsWith(pre)) return [pre, kind];
    return null;
  };

  interface VChunk {
    anchor: string | null;
    eof: boolean;
    body: BodyLine[];
  }
  interface VSec {
    kind: string;
    path: string;
    startLine: number;
    addLines: string[];
    moveTo: string | null;
    chunks: VChunk[];
  }
  const secs: VSec[] = [];
  let i = first + 1;
  while (i < last) {
    const L = lines[i]!;
    if (blank(L)) {
      i += 1;
      continue;
    }
    const h = headerOf(L);
    if (h === null) throw new Exit2(`error: parse ${i + 1}`);
    const [pre, kind] = h;
    const sec: VSec = { kind, path: L.slice(pre.length).trim(), startLine: i + 1, addLines: [], moveTo: null, chunks: [] };
    i += 1;
    const raw: { text: string; line: number }[] = [];
    while (i < last && headerOf(lines[i]!) === null) {
      raw.push({ text: lines[i]!, line: i + 1 });
      i += 1;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    if (kind === 'add') {
      for (const r of raw) {
        if (r.text.startsWith('+')) sec.addLines.push(r.text.slice(1));
        else if (r.text === '') sec.addLines.push('');
        else throw new Exit2(`error: parse ${r.line}`);
      }
    } else if (kind === 'del') {
      if (raw.length > 0) throw new Exit2(`error: parse ${raw[0]!.line}`);
    } else {
      let j = 0;
      if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
        sec.moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
        j = 1;
      }
      let chunk: VChunk | null = null;
      for (; j < raw.length; j += 1) {
        const r = raw[j]!;
        if (r.text.startsWith('@@')) {
          chunk = { anchor: r.text.slice(2).trim() || null, eof: false, body: [] };
          sec.chunks.push(chunk);
        } else if (r.text === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${r.line}`);
          chunk.eof = true;
          chunk = null;
        } else if (r.text === '' || r.text[0] === ' ' || r.text[0] === '-' || r.text[0] === '+') {
          if (chunk === null) {
            chunk = { anchor: null, eof: false, body: [] };
            sec.chunks.push(chunk);
          }
          chunk.body.push({ kind: r.text === '' ? ' ' : (r.text[0] as BodyLine['kind']), text: r.text === '' ? '' : r.text.slice(1) });
        } else {
          throw new Exit2(`error: parse ${r.line}`);
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.startLine}`);
    }
    secs.push(sec);
  }

  return secs.map(
    (s): Edit =>
      (tree) => {
        if (!safe(s.path)) throw new Fail('unsafe', s.path);
        if (s.kind === 'add') {
          if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
          tree.now.set(s.path, s.addLines.length === 0 ? '' : s.addLines.join('\n') + '\n');
          return;
        }
        if (s.kind === 'del') {
          if (tree.get(s.path) === null) throw new Fail('missing', s.path);
          tree.now.set(s.path, null);
          return;
        }
        if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
        const before = tree.get(s.path);
        if (before === null) throw new Fail('missing', s.path);
        if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
        const fl = splitFile(before);
        let cursor = 0;
        for (const ch of s.chunks) {
          if (ch.anchor !== null) {
            let found = -1;
            for (const t of tiers(strict)) {
              for (let k = cursor; k < fl.lines.length; k += 1) {
                if (cmpLine(fl.lines[k]!, ch.anchor, t)) {
                  found = k;
                  break;
                }
              }
              if (found >= 0) break;
            }
            if (found < 0) throw new Fail('no-match', s.path);
            cursor = found + 1;
          }
          const { O, N } = bodyON(ch.body);
          if (O.length === 0) {
            const at = ch.eof ? fl.lines.length : Math.min(cursor, fl.lines.length);
            const written = N.map((e) => e.text);
            fl.lines.splice(at, 0, ...written);
            cursor = at + written.length;
            continue;
          }
          let placed: { tier: number; at: number } | null = null;
          for (const t of tiers(strict)) {
            const occ = occAt(fl.lines, O, t, cursor).filter((p) => !ch.eof || p + O.length === fl.lines.length);
            if (occ.length > 0) {
              placed = { tier: t, at: occ[0]! };
              break;
            }
          }
          if (placed === null) throw new Fail('no-match', s.path);
          const written = buildWritten(fl.lines, placed.at, O, N, placed.tier);
          fl.lines.splice(placed.at, O.length, ...written);
          cursor = placed.at + written.length;
        }
        const out = joinFile(fl);
        if (s.moveTo !== null) {
          tree.now.set(s.moveTo, out);
          tree.now.set(s.path, null);
          tree.moves.push([s.path, s.moveTo]);
        } else {
          tree.now.set(s.path, out);
        }
      },
  );
}

/* ---------- the run (SPEC.md sections 1, 2 and 10) ---------- */

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const pairs = tree.moves.filter(([o, n]) => tree.original(o) !== null && tree.get(o) === null && tree.original(n) === null && tree.get(n) !== null);
  const moveNew = new Map(pairs.map(([o, n]) => [n, o]));
  const moveOld = new Set(pairs.map(([o]) => o));
  interface Row {
    key: string;
    text: string;
  }
  const rows: Row[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (moveOld.has(p)) continue;
    if (moveNew.has(p)) rows.push({ key: p, text: `R ${moveNew.get(p)!} -> ${p}` });
    else rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  const texts = rows.map((r) => r.text);
  return { code: 0, out: [...texts, `ok: ${texts.length} ${texts.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
