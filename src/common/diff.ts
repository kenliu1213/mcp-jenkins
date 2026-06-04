/**
 * Tiny line-based diff for showing config changes between two versions.
 *
 * Uses the classic LCS dynamic-programming algorithm. Returns a unified-diff
 * string (the same shape an LLM agent would expect to see from `diff -u`),
 * suitable for returning from a tool directly.
 *
 * No external dependency — adds ~30 LOC and avoids a heavyweight diff library
 * for what is essentially an XML config-comparison use case.
 */

export const unifiedDiff = (
  oldText: string,
  newText: string,
  oldLabel: string,
  newLabel: string,
  contextLines = 3,
): string => {
  const a = oldText.split("\n")
  const b = newText.split("\n")
  const m = a.length
  const n = b.length

  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array(n + 1).fill(0),
  )
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  // Walk the LCS to produce an edit script. Each op is one of:
  //   {kind: 'eq',  line}
  //   {kind: 'del', line}
  //   {kind: 'add', line}
  const ops: { kind: "eq" | "del" | "add"; line: string }[] = []
  let i = 0
  let j = 0
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      ops.push({ kind: "eq", line: a[i] })
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ kind: "del", line: a[i] })
      i++
    } else {
      ops.push({ kind: "add", line: b[j] })
      j++
    }
  }
  while (i < m) ops.push({ kind: "del", line: a[i++] })
  while (j < n) ops.push({ kind: "add", line: b[j++] })

  // Group consecutive non-equal ops into hunks, keeping `contextLines` of
  // surrounding equal lines for readability.
  const out: string[] = [`--- ${oldLabel}`, `+++ ${newLabel}`]
  const k = ops.length
  let p = 0
  while (p < k) {
    if (ops[p].kind === "eq") {
      p++
      continue
    }
    // Find start of hunk: walk back up to `contextLines` eq lines
    let hunkStart = p
    let back = 0
    while (hunkStart > 0 && ops[hunkStart - 1].kind === "eq" && back < contextLines) {
      hunkStart--
      back++
    }
    // Find end of hunk: forward past non-eq, with trailing context
    let hunkEnd = p
    while (hunkEnd < k && ops[hunkEnd].kind !== "eq") hunkEnd++
    let fwd = 0
    while (hunkEnd < k && ops[hunkEnd].kind === "eq" && fwd < contextLines) {
      hunkEnd++
      fwd++
    }

    // Compute old/new line numbers for the hunk header
    let oldLine = 1
    for (let x = 0; x < hunkStart; x++) {
      if (ops[x].kind !== "add") oldLine++
    }
    let newLine = 1
    for (let x = 0; x < hunkStart; x++) {
      if (ops[x].kind !== "del") newLine++
    }
    const hunkOldCount = ops.slice(hunkStart, hunkEnd).filter((o) => o.kind !== "add").length
    const hunkNewCount = ops.slice(hunkStart, hunkEnd).filter((o) => o.kind !== "del").length
    out.push(`@@ -${oldLine},${hunkOldCount} +${newLine},${hunkNewCount} @@`)

    for (let x = hunkStart; x < hunkEnd; x++) {
      const op = ops[x]
      if (op.kind === "eq") out.push(` ${op.line}`)
      else if (op.kind === "del") out.push(`-${op.line}`)
      else out.push(`+${op.line}`)
    }

    p = hunkEnd
  }

  return out.join("\n")
}
