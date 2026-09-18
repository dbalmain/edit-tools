#!/usr/bin/env node
// In-process timing driver for bench_secondary_cost.py.
//
// One process, all documents: the markdown and markdown_inline tables are
// JSON-parsed once, matching a warm editor tab, and the ON/OFF arms interleave
// inside that process so a GC pause cannot land on only one arm.
//
// Stdin is a JSON job from the orchestrator. Stdout is a JSON result. Progress
// goes to stderr.

import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseDoc } from "./ts_doc.mjs"
import { injectAll } from "./ts_inject.mjs"
import { Language } from "./ts_lr.mjs"
import { attachSecondaries } from "./ts_secondary.mjs"

const encoder = new TextEncoder()

function fail(message) {
  process.stderr.write(`bench_secondary_cost: ${message}\n`)
  process.exit(1)
}

function blobFor(blobs, name) {
  if (blobs.has(name)) return blobs.get(name)
  const path = join(blobs.dir, `${name}.blob.json`)
  const blob = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null
  blobs.set(name, blob)
  return blob
}

function hostInlines(root) {
  let count = 0
  let bytes = 0
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node.language !== undefined) continue
    if (node.type === "inline") {
      count++
      bytes += node.end - node.start
    }
    const children = node.children ?? []
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
  }
  return { count, bytes }
}

function summarise(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  return { median: sorted[sorted.length >> 1], max: sorted[sorted.length - 1], min: sorted[0] }
}

function secondarySpan(entries) {
  let bytes = 0
  let dirty = 0
  for (const entry of entries) {
    bytes += entry.end - entry.start
    if (entry.outcome === "dirty") dirty++
  }
  return { count: entries.length, bytes, dirty }
}

async function parseOff(text, blobs, injections) {
  const blob = blobFor(blobs, "markdown")
  const t0 = process.hrtime.bigint()
  const source = encoder.encode(text)
  const doc = parseDoc(blob, "markdown", source, "<markdown buffer>")
  const tBlock = process.hrtime.bigint()
  if (injections.sites.markdown) {
    const load = async (guest) => (injections.blobs[guest] ? blobFor(blobs, guest) : null)
    await injectAll(doc, source, injections, load, new Map([["markdown", blob]]))
  }
  const t1 = process.hrtime.bigint()
  return {
    doc,
    totalNs: Number(t1 - t0),
    blockNs: Number(tBlock - t0),
    injectNs: Number(t1 - tBlock),
  }
}

async function parseOn(text, blobs, injections, secondaries) {
  const blob = blobFor(blobs, "markdown")
  const t0 = process.hrtime.bigint()
  const source = encoder.encode(text)
  const doc = parseDoc(blob, "markdown", source, "<markdown buffer>")
  const tBlock = process.hrtime.bigint()
  let loadAt = 0n
  await attachSecondaries(doc, source, secondaries, (name) => {
    loadAt = process.hrtime.bigint()
    return blobFor(blobs, name)
  })
  const tSec = process.hrtime.bigint()
  if (injections.sites.markdown) {
    const load = async (guest) => (injections.blobs[guest] ? blobFor(blobs, guest) : null)
    await injectAll(doc, source, injections, load, new Map([["markdown", blob]]))
  }
  const t1 = process.hrtime.bigint()
  // `await load()` yields one microtask even when `load` returns the blob
  // itself. The loop over ranges after that yield is the stretch that cannot
  // paint. `loadAt === 0n` is the no-host-node path, where attachSecondaries
  // never reaches `load` and the whole call is the walk.
  const stretchNs = loadAt === 0n ? Number(tSec - tBlock) : Number(tSec - loadAt)
  const walkNs = loadAt === 0n ? Number(tSec - tBlock) : Number(loadAt - tBlock)
  return {
    doc,
    totalNs: Number(t1 - t0),
    blockNs: Number(tBlock - t0),
    stretchNs,
    walkNs,
    attachNs: Number(tSec - tBlock),
    injectNs: Number(t1 - tSec),
  }
}

function ctorCost(text, blobs) {
  const source = encoder.encode(text)
  const doc = parseDoc(blobFor(blobs, "markdown"), "markdown", source, "<markdown buffer>")
  const ranges = []
  const stack = [doc.root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node.language !== undefined) continue
    if (node.type === "inline") ranges.push(node)
    const children = node.children ?? []
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
  }
  const inlineBlob = blobFor(blobs, "markdown_inline")
  const t0 = process.hrtime.bigint()
  for (const _ of ranges) new Language(inlineBlob)
  const ctorNs = Number(process.hrtime.bigint() - t0)
  return { ranges: ranges.length, ctorNs }
}

async function measureFile(item, blobs, injections, secondaries, warmup, iterations) {
  const text = readFileSync(item.path, "utf8")
  const source = encoder.encode(text)
  const probe = parseDoc(blobFor(blobs, "markdown"), "markdown", source, item.id)
  const expected = hostInlines(probe.root)

  for (let i = 0; i < warmup; i++) {
    await parseOn(text, blobs, injections, secondaries)
    await parseOff(text, blobs, injections)
  }

  const onTotals = []
  const offTotals = []
  const stretches = []
  const walks = []
  const attaches = []
  const onBlocks = []
  const offBlocks = []
  let onDoc
  let offDoc
  for (let i = 0; i < iterations; i++) {
    const onFirst = i % 2 === 0
    const first = onFirst
      ? await parseOn(text, blobs, injections, secondaries)
      : await parseOff(text, blobs, injections)
    const second = onFirst
      ? await parseOff(text, blobs, injections)
      : await parseOn(text, blobs, injections, secondaries)
    const on = onFirst ? first : second
    const off = onFirst ? second : first
    onDoc = on.doc
    offDoc = off.doc
    onTotals.push(on.totalNs)
    offTotals.push(off.totalNs)
    stretches.push(on.stretchNs)
    walks.push(on.walkNs)
    attaches.push(on.attachNs)
    onBlocks.push(on.blockNs)
    offBlocks.push(off.blockNs)
  }

  if (offDoc.secondary !== undefined) {
    fail(`${item.id}: OFF produced ${offDoc.secondary.length} secondary entries`)
  }
  const onEntries = onDoc.secondary ?? []
  if (expected.count === 0) {
    if (onEntries.length !== 0) {
      fail(`${item.id}: expected no secondary, ON produced ${onEntries.length}`)
    }
  } else if (onEntries.length !== expected.count) {
    fail(
      `${item.id}: ON secondary ${onEntries.length} != host inline count ${expected.count}`,
    )
  }
  if (item.role === "negative" && expected.count !== 0) {
    fail(`${item.id}: negative control has ${expected.count} inline range(s)`)
  }
  if (item.role === "positive" && expected.count === 0) {
    fail(`${item.id}: positive control has no inline range`)
  }

  const on = summarise(onTotals)
  const off = summarise(offTotals)
  const span = secondarySpan(onEntries)
  return {
    id: item.id,
    role: item.role,
    bytes: source.length,
    warmup,
    iterations,
    expected,
    secondary: span,
    on,
    off,
    deltaNs: on.median - off.median,
    stretch: summarise(stretches),
    walk: summarise(walks),
    attach: summarise(attaches),
    onBlock: summarise(onBlocks),
    offBlock: summarise(offBlocks),
  }
}

async function main() {
  const job = JSON.parse(readFileSync(0, "utf8"))
  const blobs = new Map()
  blobs.dir = job.blobDir
  if (!blobFor(blobs, "markdown") || !blobFor(blobs, "markdown_inline")) {
    fail(`missing markdown or markdown_inline blob in ${job.blobDir}`)
  }
  const results = []
  for (const item of job.files) {
    process.stderr.write(`${item.role}\t${item.id}\n`)
    const row = await measureFile(
      item, blobs, job.injections, job.secondaries, job.warmup, job.iterations,
    )
    if (item.ctor) row.ctor = ctorCost(readFileSync(item.path, "utf8"), blobs)
    results.push(row)
  }
  process.stdout.write(JSON.stringify({ warmup: job.warmup, iterations: job.iterations, results }) + "\n")
}

await main()
