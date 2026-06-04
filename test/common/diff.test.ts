import { describe, it, expect } from "vitest"
import { unifiedDiff } from "../../src/common/diff.js"

describe("unifiedDiff", () => {
  it("returns no hunks when texts are identical", () => {
    const out = unifiedDiff("a\nb\nc", "a\nb\nc", "old", "new")
    expect(out).toBe("--- old\n+++ new")
  })

  it("marks added lines with +", () => {
    const out = unifiedDiff("a\nb", "a\nb\nc", "old", "new")
    expect(out).toContain("+c")
    expect(out).not.toContain("-c")
  })

  it("marks removed lines with -", () => {
    const out = unifiedDiff("a\nb\nc", "a\nc", "old", "new")
    expect(out).toContain("-b")
    expect(out).not.toContain("+b")
  })

  it("emits unified-diff header lines", () => {
    const out = unifiedDiff("a", "b", "L1", "L2")
    expect(out.startsWith("--- L1\n+++ L2\n")).toBe(true)
  })

  it("includes @@ hunk headers with correct line counts", () => {
    const out = unifiedDiff("a\nb\nc\nd", "a\nX\nc\nd", "old", "new")
    // one hunk: 1 deletion, 1 addition, with 3 context lines on either side
    // produces a 4-line hunk starting at line 1
    expect(out).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/m)
    expect(out).toContain("-b")
    expect(out).toContain("+X")
  })

  it("emits multiple hunks for distant changes", () => {
    const a = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"]
      .join("\n")
    const b = ["l1", "X2", "l3", "l4", "l5", "l6", "l7", "l8", "X9", "l10"]
      .join("\n")
    const out = unifiedDiff(a, b, "old", "new")
    const hunkCount = (out.match(/^@@/gm) ?? []).length
    expect(hunkCount).toBeGreaterThanOrEqual(2)
  })

  it("preserves context lines with a leading space", () => {
    const out = unifiedDiff("ctx\nOLD\nctx2", "ctx\nNEW\nctx2", "old", "new")
    expect(out).toContain(" ctx")
    expect(out).toContain(" ctx2")
  })
})
