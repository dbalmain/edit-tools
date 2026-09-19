#!/usr/bin/env node
// In-process timing driver for bench_format_pass.py.
//
// One process, all documents: parse tables and packages load once, matching a
// warm editor tab. format() is the clock; parse, inject, and project sit
// outside it. Stdin is a JSON job; stdout is a JSON result; progress is stderr.

import { createRequire } from "node:module"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parseDoc } from "./ts_doc.mjs"
import { injectAll } from "./ts_inject.mjs"
import { attachSecondaries } from "./ts_secondary.mjs"
import { project, reasons, RUN } from "./prose.mjs"

const require = createRequire(import.meta.url)
const { format, Refusal } = require("../runtime-js/bundle.js")

const encoder = new TextEncoder()
const decoder = new TextDecoder("utf-8", { fatal: true })

const CONTAINERS = new Set([
  "block_quote",
  "list_item",
  "list",
  "fenced_code_block",
  "html_block",
])

function fail(message) {
  process.stderr.write(`bench_format_pass: ${message}\n`)
  process.exit(1)
}

function blobFor(cache, dir, name) {
  if (cache.has(name)) return cache.get(name)
  const path = join(dir, `${name}.blob.json`)
  const blob = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null
  cache.set(name, blob)
  return blob
}

function loadPackage(cache, dir, name) {
  if (cache.has(name)) return cache.get(name)
  const path = join(dir, `${name}.json`)
  const pkg = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null
  cache.set(name, pkg)
  return pkg
}

function treeLanguages(tree) {
  const languages = new Set([tree.language])
  const visit = (node) => {
    if (node.language !== undefined && node.opaque !== true) languages.add(node.language)
    const children = node.children ?? []
    for (const child of children) visit(child)
  }
  visit(tree.root)
  return languages
}

function pkgsFor(tree, markdownPkg, packageDir, cache) {
  const map = new Map()
  for (const lang of treeLanguages(tree)) {
    const pkg = lang === "markdown" ? markdownPkg : loadPackage(cache, packageDir, lang)
    if (pkg) map.set(lang, pkg)
  }
  return map
}

function summarise(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  return { median: sorted[sorted.length >> 1], max: sorted[sorted.length - 1], min: sorted[0] }
}

function nodeShape(node) {
  const out = []
  const stack = [node]
  while (stack.length > 0) {
    const item = stack.pop()
    out.push(item.type)
    const children = item.children ?? []
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
  }
  return out
}

function findParagraph(root, start) {
  const stack = [root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node.type === "paragraph" && node.start === start) return node
    const children = node.children ?? []
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i])
  }
  return null
}

// A2.1 **superseded this helper**, and it is left delegating rather than
// deleted so the bench's two arms keep their names and its recorded numbers
// stay readable against the commit that produced them.
//
// It used to widen `project` by also admitting the `block acquisition`
// verdict, to price "Option C": admit the hazardous paragraphs, format, then
// rescan line starts and re-project whatever moved. A2.1 settled that question
// the other way -- a hazardous atom now has both flanking gaps protected
// inside `partition`, so such a paragraph is admitted *and* safe with no
// format-then-inspect pass, and the `block acquisition` verdict no longer
// exists to widen by. Keeping the old arm would have left a branch that can
// never fire, which reads as coverage and is not.
function projectAdmittingBlockAcquisition(doc) {
  return project(doc)
}

function runFormat(tree, packages, width) {
  try {
    return { text: format(tree, packages, width) }
  } catch (error) {
    const message = error instanceof Refusal ? error.message : String(error)
    return { refused: message }
  }
}

function timeFormat(tree, packages, width, warmup, iterations) {
  const probe = runFormat(tree, packages, width)
  if (probe.refused !== undefined) {
    return { refused: probe.refused, warmup, iterations }
  }
  for (let i = 1; i < warmup; i++) format(tree, packages, width)
  const samples = []
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint()
    format(tree, packages, width)
    samples.push(Number(process.hrtime.bigint() - t0))
  }
  return { ...summarise(samples), warmup, iterations }
}

async function buildDoc(text, blobs, dir, injections, secondaries, id) {
  const source = encoder.encode(text)
  const blob = blobFor(blobs, dir, "markdown")
  const doc = parseDoc(blob, "markdown", source, id)
  await attachSecondaries(doc, source, secondaries, (name) => blobFor(blobs, dir, name))
  if (injections.sites.markdown) {
    const load = async (guest) => (injections.blobs[guest] ? blobFor(blobs, dir, guest) : null)
    await injectAll(doc, source, injections, load, new Map([["markdown", blob]]))
  }
  return doc
}

function paragraphBytes(doc, start) {
  const para = findParagraph(doc.root, start)
  if (!para) return null
  const source = encoder.encode(doc.source)
  return decoder.decode(source.subarray(para.start, para.end))
}

function measureMini(text, blobs, dir, a1Pkg, packageDir, pkgCache, warmup, iterations, widths) {
  const source = encoder.encode(text.endsWith("\n") ? text : `${text}\n`)
  const mini = parseDoc(blobFor(blobs, dir, "markdown"), "markdown", source, "<mini>")
  const projected = projectAdmittingBlockAcquisition(mini)
  const pkgs = pkgsFor(projected, a1Pkg, packageDir, pkgCache)
  const originalShape = nodeShape(mini.root)
  const formatted = {}
  const shapeChanged = {}
  for (const width of widths) {
    const result = runFormat(projected, pkgs, width)
    if (result.refused !== undefined) {
      formatted[String(width)] = { refused: result.refused }
      shapeChanged[String(width)] = false
      continue
    }
    formatted[String(width)] = result.text
    const again = parseDoc(
      blobFor(blobs, dir, "markdown"),
      "markdown",
      encoder.encode(result.text),
      "<mini-formatted>",
    )
    shapeChanged[String(width)] = nodeShape(again.root).join("\0") !== originalShape.join("\0")
  }
  const timed = timeFormat(projected, pkgs, 80, warmup, iterations)
  const runs = []
  const stack = [projected.root]
  while (stack.length > 0) {
    const node = stack.pop()
    if (node.type === RUN) runs.push(node)
    for (const child of node.children ?? []) stack.push(child)
  }
  return { source: decoder.decode(source), formatted, shapeChanged, subtree: timed, projected: runs.length > 0 }
}

async function measureFile(item, ctx) {
  const text = readFileSync(item.path, "utf8")
  const doc = await buildDoc(text, ctx.blobs, ctx.blobDir, ctx.injections, ctx.secondaries, item.id)
  const source = encoder.encode(doc.source)
  const verdicts = reasons(doc)
  const eligible = verdicts.filter(([, why]) => why === "eligible").length
  const blockAcquisition = verdicts.filter(([, why]) => why === "block acquisition").length
  const a1 = project(doc)
  const admitted = projectAdmittingBlockAcquisition(doc)
  const shippedPkgs = pkgsFor(doc, ctx.shippedPackage, ctx.packageDir, ctx.pkgCache)
  const a1Pkgs = pkgsFor(a1, ctx.a1Package, ctx.packageDir, ctx.pkgCache)
  const admittedPkgs = pkgsFor(admitted, ctx.a1Package, ctx.packageDir, ctx.pkgCache)

  for (let i = 0; i < ctx.warmup; i++) {
    runFormat(doc, shippedPkgs, 80)
    runFormat(a1, a1Pkgs, 80)
  }

  const shippedSamples = []
  const projectedSamples = []
  let shippedRefused
  let projectedRefused
  for (let i = 0; i < ctx.iterations; i++) {
    const projectedFirst = i % 2 === 0
    const firstTree = projectedFirst ? a1 : doc
    const firstPkgs = projectedFirst ? a1Pkgs : shippedPkgs
    const secondTree = projectedFirst ? doc : a1
    const secondPkgs = projectedFirst ? shippedPkgs : a1Pkgs
    const t0 = process.hrtime.bigint()
    const first = runFormat(firstTree, firstPkgs, 80)
    const firstNs = Number(process.hrtime.bigint() - t0)
    const t1 = process.hrtime.bigint()
    const second = runFormat(secondTree, secondPkgs, 80)
    const secondNs = Number(process.hrtime.bigint() - t1)
    const projectedResult = projectedFirst ? first : second
    const shippedResult = projectedFirst ? second : first
    const projectedNs = projectedFirst ? firstNs : secondNs
    const shippedNs = projectedFirst ? secondNs : firstNs
    if (projectedResult.refused !== undefined) projectedRefused = projectedResult.refused
    else projectedSamples.push(projectedNs)
    if (shippedResult.refused !== undefined) shippedRefused = shippedResult.refused
    else shippedSamples.push(shippedNs)
  }

  const paragraphs = []
  for (const [start, why] of verdicts) {
    if (why !== "block acquisition") continue
    const slice = paragraphBytes(doc, start)
    if (slice === null) fail(`${item.id}: no paragraph at ${start}`)
    paragraphs.push({
      start,
      ...measureMini(
        slice, ctx.blobs, ctx.blobDir, ctx.a1Package, ctx.packageDir, ctx.pkgCache,
        ctx.warmup, ctx.iterations, ctx.widths,
      ),
    })
  }

  if (item.role === "negative" && (eligible !== 0 || blockAcquisition !== 0)) {
    fail(`${item.id}: negative control has ${eligible} eligible and ${blockAcquisition} block-acquisition paragraph(s)`)
  }
  if (item.role === "positive-trip" && blockAcquisition === 0) {
    fail(`${item.id}: positive-trip control has no block-acquisition paragraph`)
  }

  const admittedOnce = runFormat(admitted, admittedPkgs, 80)
  return {
    id: item.id,
    role: item.role,
    bytes: source.length,
    warmup: ctx.warmup,
    iterations: ctx.iterations,
    eligible,
    blockAcquisition,
    shipped: shippedRefused !== undefined
      ? { refused: shippedRefused }
      : summarise(shippedSamples),
    projected: projectedRefused !== undefined
      ? { refused: projectedRefused }
      : summarise(projectedSamples),
    admittedFormat: admittedOnce.refused !== undefined
      ? { refused: admittedOnce.refused }
      : { bytes: encoder.encode(admittedOnce.text).length },
    paragraphs,
  }
}

async function main() {
  const job = JSON.parse(readFileSync(0, "utf8"))
  const blobs = new Map()
  if (!blobFor(blobs, job.blobDir, "markdown")) {
    fail(`missing markdown blob in ${job.blobDir}`)
  }
  const ctx = {
    blobs,
    blobDir: job.blobDir,
    packageDir: job.packageDir,
    pkgCache: new Map(),
    shippedPackage: job.shippedPackage,
    a1Package: job.a1Package,
    injections: job.injections,
    secondaries: job.secondaries,
    warmup: job.warmup,
    iterations: job.iterations,
    widths: job.widths,
  }
  const results = []
  for (const item of job.files) {
    process.stderr.write(`${item.role} ${item.id}\n`)
    results.push(await measureFile(item, ctx))
  }
  process.stdout.write(JSON.stringify({
    warmup: job.warmup,
    iterations: job.iterations,
    widths: job.widths,
    results,
  }) + "\n")
}

await main()
