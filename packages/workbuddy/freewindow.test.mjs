// The free model's daily token window: what WorkBuddy AI refuses a chat on
// long before a free plan's credits are spent, and which the credit meter
// does not show. Every figure here is one measured on a real account; see
// freeWindowOf for the readings and how each was checked.
import { test, expect, beforeAll } from "bun:test"
import { tmpdir } from "node:os"
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

let _internal
beforeAll(async () => {
  // as usage.test.mjs: run with HOME=$(mktemp -d) bun test
  if (![tmpdir(), realpathSync(tmpdir())].some((t) => homedir().startsWith(t))) throw new Error("run with HOME=$(mktemp -d) bun test")
  ;({ _internal } = await import("./index.mjs"))
})

// a row of magpie's usage ledger (usage.Record), as the plugin reads it
const row = (t, { status = 200, in: inp = 0, cache = 0, out = 0, err = "", model = "deepseek-v4.1-flash", account = "me@example.com", provider = "workbuddy-ai" } = {}) => ({
  provider,
  providerAccount: account,
  model,
  t,
  status,
  in: inp,
  cache_read: cache,
  out,
  err,
})
const iso = (s) => new Date(s).toISOString()
const at = (s) => Date.parse(s)

// the vendor's words before the reset it names
const TIMEOUT_BEFORE_RESET = "WorkBuddy AI: usage exceeds frequency limit, but don't worry, your usage will reset at "

// the refusal WorkBuddy AI sends when the window is spent
const refusal = (reset, account = "me@example.com") =>
  row(`2026-10-20T19:47:41+08:00`, {
    status: 429,
    account,
    err: `WorkBuddy AI: usage exceeds frequency limit, but don't worry, your usage will reset at ${reset} UTC+8, alternatively, you can switch to the other models to continue using it.`,
  })

test("a window counts in + cache_read + out", () => {
  const rows = [row("2026-10-20T19:53:48+08:00", { in: 1_000_000, cache: 4_000_000, out: 100_000 }), row("2026-10-20T20:00:00+08:00", { in: 500_000, cache: 2_000_000 })]
  const w = _internal.freeWindowOf(rows, "me@example.com", at("2026-10-20T21:00:00+08:00"))
  expect(w.amount).toBe(7_600_000)
  expect(w.used).toBeCloseTo(7.6, 6)
  expect(w.resetsAt).toBe(iso("2026-10-21T19:53:48+08:00"))
  expect(w.span).toBe(86400)
  expect(w.limit).toBe(1e8)
  expect(w.unit).toBe("tokens")
  expect(w.display).toBe("7.6M / 100M")
  expect(w.models).toEqual(["deepseek-v4.1-flash", "deepseek-v4.1-flash-sg"])
})

// reading in + out alone is 20x too small and never reaches a cap, so a
// window read that way looks empty while it is full
test("cache_read alone can fill a window", () => {
  const w = _internal.freeWindowOf([row("2026-10-20T19:53:48+08:00", { in: 200, cache: 99_000_000, out: 300 })], "me@example.com", at("2026-10-20T21:00:00+08:00"))
  expect(w.used).toBeGreaterThan(98)
  expect(w.used).toBeLessThanOrEqual(100)
})

// the reset a refusal names is the old window's end; the new one starts at
// the next request, which a real account made 68 minutes later
test("a new window opens at the next request, not at the reset instant", () => {
  const rows = [
    row("2026-10-16T15:40:03+08:00", { in: 60_000_000 }),
    row("2026-10-17T08:00:00+08:00", { in: 40_000_000 }),
    refusal("2026-10-17 08:00:13"),
    row("2026-10-17T09:08:00+08:00", { in: 1_000 }),
  ]
  const w = _internal.freeWindowOf(rows, "me@example.com", at("2026-10-17T10:00:00+08:00"))
  expect(w.resetsAt).toBe(iso("2026-10-18T09:08:00+08:00"))
  expect(w.amount).toBe(1_000)
})

// a window never refused still ends 24h after its first request
test("an unrefused window lapses 24h after its first request", () => {
  const rows = [row("2026-10-19T19:52:24+08:00", { in: 90_000_000 }), row("2026-10-19T23:00:00+08:00", { in: 2_000_000 })]
  expect(_internal.freeWindowOf(rows, "me@example.com", at("2026-10-20T19:00:00+08:00")).amount).toBe(92_000_000)
  // lapsed: nothing is exhausted, so no window is reported
  expect(_internal.freeWindowOf(rows, "me@example.com", at("2026-10-20T20:00:00+08:00"))).toBeNull()
})

// the paid id draws on the same window, so its rows are in this one
test("-sg counts in the same window as the free id", () => {
  const rows = [row("2026-10-20T19:53:48+08:00", { in: 50_000_000 }), row("2026-10-20T20:00:00+08:00", { in: 10_000, model: "deepseek-v4.1-flash-sg" })]
  const w = _internal.freeWindowOf(rows, "me@example.com", at("2026-10-20T21:00:00+08:00"))
  expect(w.amount).toBe(50_010_000)
  expect(w.models).toEqual(["deepseek-v4.1-flash", "deepseek-v4.1-flash-sg"])
})

test("other accounts, other models and the China build are left out", () => {
  const rows = [
    row("2026-10-20T19:53:48+08:00", { in: 1_000 }),
    row("2026-10-20T19:54:00+08:00", { in: 9_000_000, account: "other@example.com" }),
    row("2026-10-20T19:55:00+08:00", { in: 9_000_000, model: "glm-5.3-flash" }),
    row("2026-10-20T19:56:00+08:00", { in: 9_000_000, model: "kimi-k2.6" }),
    row("2026-10-20T19:57:00+08:00", { in: 9_000_000, provider: "workbuddy" }),
  ]
  expect(_internal.freeWindowOf(rows, "me@example.com", at("2026-10-20T21:00:00+08:00")).amount).toBe(1_000)
})

// a refusal carries no tokens: it neither counts nor opens a window
test("a 429 neither counts nor opens a window", () => {
  const rows = [row("2026-10-20T19:53:48+08:00", { in: 100 }), row("2026-10-20T22:00:00+08:00", { status: 429, in: 5_000, err: "429 usage exceeds frequency limit" })]
  const w = _internal.freeWindowOf(rows, "me@example.com", at("2026-10-20T23:00:00+08:00"))
  expect(w.amount).toBe(100)
  expect(w.resetsAt).toBe(iso("2026-10-21T19:53:48+08:00"))
})

// a refusal with no readable reset time is no edge; the 24h span still ends
// the window
test("a refusal that names no reset falls back to the 24h span", () => {
  const rows = [
    row("2026-10-20T10:00:00+08:00", { in: 99_000_000 }),
    row("2026-10-20T12:00:00+08:00", { status: 429, err: "WorkBuddy AI: usage exceeds frequency limit" }),
    row("2026-10-21T11:00:00+08:00", { in: 1_000 }),
  ]
  const w = _internal.freeWindowOf(rows, "me@example.com", at("2026-10-21T12:00:00+08:00"))
  expect(w.resetsAt).toBe(iso("2026-10-22T11:00:00+08:00"))
  expect(w.amount).toBe(1_000)
})

test("nothing to read yields no window, not a made-up one", () => {
  expect(_internal.freeWindowOf([], "me@example.com")).toBeNull()
  expect(_internal.freeWindowOf(null, "me@example.com")).toBeNull()
  expect(_internal.freeWindowOf([row("2026-10-20T19:53:48+08:00")], "nobody@example.com")).toBeNull()
  expect(_internal.freeWindowOf([row("2026-10-20T19:53:48+08:00", { status: 429, err: "429 usage exceeds frequency limit" })], "me@example.com")).toBeNull()
})

test("the card reads a token count, not a credits count", () => {
  expect(_internal.tokensShort(99_971_831)).toBe("100.0M")
  expect(_internal.tokensShort(11_950_000)).toBe("11.9M")
  expect(_internal.tokensShort(812_400)).toBe("812k")
  expect(_internal.tokensShort(6)).toBe("6")
})

test("no ledger means no window rather than a guess", () => {
  // HOME is a temp dir in tests and no folder it reads holds a ledger
  expect(_internal.freeWindowRows(Date.now(), join(homedir(), "magpie-test-nowhere"), {}, homedir())).toBeNull()
})

// --- the review's points, each red on 33ca87f8 -------------------------

// point 1: an account refused under the cap read as 93% because the rest of
// its spending was on another machine. The refusal is the one exact signal
// there is: a 429 whose named reset is still ahead makes the window full.
test("an account refused under the cap reads full, not 93%", () => {
  const rows = [
    row("2026-10-18T19:47:00+08:00", { in: 62_000_000, cache: 30_000_000, out: 700_000 }),
    row("2026-10-18T19:52:00+08:00", { in: 92_962, model: "deepseek-v4.1-flash-sg" }),
    row("2026-10-18T19:52:04+08:00", { status: 429, err: `${TIMEOUT_BEFORE_RESET}2026-10-19 19:52:24 UTC+8, alternatively, you can switch to the other models to continue using it.` }),
  ]
  const w = _internal.freeWindowOf(rows, "me@example.com", at("2026-10-18T23:00:00+08:00"))
  expect(w.amount).toBe(1e8) // the rows sum to 92,792,962
  expect(w.used).toBe(100)
  expect(w.display).toBe("100.0M / 100M")
  expect(w.resetsAt).toBe(iso("2026-10-19T19:52:24+08:00"))
  expect(w.refused).toBe(true)
})

// the refusal belongs to its window: once its reset passes, the sum reads
test("a refusal whose reset has passed does not hold the next window full", () => {
  const rows = [
    row("2026-10-18T19:47:00+08:00", { in: 92_000_000 }),
    row("2026-10-18T19:52:04+08:00", { status: 429, err: `${TIMEOUT_BEFORE_RESET}2026-10-19 19:52:24 UTC+8, alternatively, you can switch to the other models to continue using it.` }),
    row("2026-10-19T20:00:00+08:00", { in: 1_000 }),
  ]
  const w = _internal.freeWindowOf(rows, "me@example.com", at("2026-10-19T21:00:00+08:00"))
  expect(w.amount).toBe(1_000)
  expect(w.refused).toBeUndefined()
})

// point 6: the offset is read from the refusal, and one that cannot be read
// is no edge at all rather than +08:00
test("the reset's offset is read from the text", () => {
  expect(_internal.windowOffset("reset at 2026-10-20 19:47:41 UTC+8")).toBe(480)
  expect(_internal.windowOffset("reset at 2026-10-20 19:47:41 UTC+08:00")).toBe(480)
  expect(_internal.windowOffset("reset at 2026-10-20 19:47:41 GMT-5")).toBe(-300)
  expect(_internal.windowOffset("reset at 2026-10-20 19:47:41 UTC+05:30")).toBe(330)
  expect(_internal.windowOffset("reset at 2026-10-20 19:47:41")).toBeNull()
  expect(_internal.windowReset("reset at 2026-10-20 19:47:41 UTC+8")).toBe(Date.parse("2026-10-20T19:47:41+08:00"))
  expect(Number.isNaN(_internal.windowReset("reset at 2026-10-20 19:47:41"))).toBe(true)
})

// point 3: magpie keeps usage.jsonl in appdir.Config(), which is the folder
// the plugin host runs in — portable, or $XDG_CONFIG_HOME/magpie — and only
// ~/.config/magpie otherwise
test("the ledger is found through $XDG_CONFIG_HOME", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-xdg-"))
  try {
    const home = join(root, "home")
    const xdg = join(root, "xdg")
    mkdirSync(join(home, ".config", "magpie"), { recursive: true })
    mkdirSync(join(xdg, "magpie"), { recursive: true })
    writeFileSync(join(home, ".config", "magpie", "usage.jsonl"), JSON.stringify(row("2026-10-01T10:00:00+08:00", { in: 1 })) + "\n")
    writeFileSync(join(xdg, "magpie", "usage.jsonl"), JSON.stringify(row("2026-10-20T10:00:00+08:00", { in: 5_000_000 })) + "\n")
    const rows = _internal.freeWindowRows(at("2026-10-20T12:00:00+08:00"), join(root, "elsewhere"), { XDG_CONFIG_HOME: xdg }, home)
    expect(rows.map((r) => r.in)).toEqual([5_000_000])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the ledger is found through the folder the host runs in", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-cwd-"))
  try {
    writeFileSync(join(root, "usage.jsonl"), JSON.stringify(row("2026-10-20T10:00:00+08:00", { in: 7_000_000 })) + "\n")
    const rows = _internal.freeWindowRows(at("2026-10-20T12:00:00+08:00"), root, {}, join(root, "nohome"))
    expect(rows.map((r) => r.in)).toEqual([7_000_000])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// point 4: a heavy ledger runs to hundreds of MB and only the last 48h bear
// on the window, so the read starts at the end and stops once past them
test("the read stops once past 48 hours, from the end", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-tail-"))
  try {
    const now = at("2026-10-20T20:00:00+08:00")
    const lines = []
    for (let i = 0; i < 3000; i++) lines.push(JSON.stringify(row(new Date(now - (2999 - i) * 3600_000).toISOString(), { in: i === 2999 ? 9_000_000 : 1 })))
    lines.push(JSON.stringify({ ...row(new Date(now).toISOString(), { in: 4 }), provider: "zcode" }))
    writeFileSync(join(root, "usage.jsonl"), lines.join("\n") + "\n" + '{"provider":"workbuddy-ai","t":"2026-10-20T')
    const rows = _internal.freeWindowRows(now, root, {}, join(root, "nohome"))
    expect(rows.length).toBeLessThan(60)
    expect(rows.every((r) => r.provider === "workbuddy-ai")).toBe(true)
    expect(rows.at(-1).in).toBe(9_000_000)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
