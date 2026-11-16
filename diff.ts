// Line-based diffs: enough of unified diff for pull-request file lists and
// commit views — an LCS over lines, hunks with three lines of context.

export interface FileDiff {
  additions: number;
  deletions: number;
  patch: string;
}

type Op = { kind: 'same' | 'add' | 'del'; line: string };

function diffOps(a: string[], b: string[]): Op[] {
  // LCS lengths table; inputs here are suite-sized files, so O(n*m) is fine.
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', line: a[i] });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: 'del', line: a[i] });
      i += 1;
    } else {
      ops.push({ kind: 'add', line: b[j] });
      j += 1;
    }
  }
  while (i < n) { ops.push({ kind: 'del', line: a[i] }); i += 1; }
  while (j < m) { ops.push({ kind: 'add', line: b[j] }); j += 1; }
  return ops;
}

const CONTEXT = 3;

/** A unified-diff patch for old -> new text, or undefined for binary input. */
export function diffText(oldText: string, newText: string): FileDiff {
  if (oldText.includes('\0') || newText.includes('\0')) return { additions: 0, deletions: 0, patch: '' };
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  // A trailing newline produces a final empty element; drop it for diffing.
  if (a.length > 0 && a[a.length - 1] === '') a.pop();
  if (b.length > 0 && b[b.length - 1] === '') b.pop();
  const ops = diffOps(a, b);
  let additions = 0;
  let deletions = 0;
  for (const op of ops) {
    if (op.kind === 'add') additions += 1;
    else if (op.kind === 'del') deletions += 1;
  }
  // Group into hunks: change clusters separated by more than 2*CONTEXT same lines split.
  const hunks: Op[][] = [];
  let current: Op[] = [];
  let pendingSame: Op[] = [];
  const flushPending = (keep: number) => {
    current.push(...pendingSame.slice(0, keep));
    pendingSame = [];
  };
  for (const op of ops) {
    if (op.kind === 'same') {
      pendingSame.push(op);
      continue;
    }
    if (current.length === 0) {
      // Start of a hunk: take up to CONTEXT leading same lines.
      current.push(...pendingSame.slice(-CONTEXT));
    } else if (pendingSame.length > CONTEXT * 2) {
      flushPending(CONTEXT);
      hunks.push(current);
      current = pendingSame.slice(-CONTEXT);
    } else {
      flushPending(pendingSame.length);
    }
    pendingSame = [];
    current.push(op);
  }
  if (current.length > 0) {
    current.push(...pendingSame.slice(0, CONTEXT));
    hunks.push(current);
  }
  // Render with @@ headers.
  const rendered: string[] = [];
  let aPos = 1;
  let bPos = 1;
  let cursor = 0;
  const opIndex = ops;
  for (const hunk of hunks) {
    // Advance positions to the hunk start.
    const startIdx = opIndex.indexOf(hunk[0], cursor);
    for (let k = cursor; k < startIdx; k += 1) {
      if (opIndex[k].kind !== 'add') aPos += 1;
      if (opIndex[k].kind !== 'del') bPos += 1;
    }
    cursor = startIdx + hunk.length;
    let aCount = 0;
    let bCount = 0;
    const lines: string[] = [];
    for (const op of hunk) {
      if (op.kind === 'same') { lines.push(` ${op.line}`); aCount += 1; bCount += 1; }
      else if (op.kind === 'del') { lines.push(`-${op.line}`); aCount += 1; }
      else { lines.push(`+${op.line}`); bCount += 1; }
    }
    rendered.push(`@@ -${aPos},${aCount} +${bPos},${bCount} @@`);
    rendered.push(...lines);
    for (const op of hunk) {
      if (op.kind !== 'add') aPos += 1;
      if (op.kind !== 'del') bPos += 1;
    }
  }
  return { additions, deletions, patch: rendered.join('\n') };
}
