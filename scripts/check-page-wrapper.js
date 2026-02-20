#!/usr/bin/env node
const fs = require('fs')
const path = require('path')

const root = process.cwd()
const pagesDir = path.join(root, 'pages')

function walk(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const ent of entries) {
    const abs = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      walk(abs, out)
      continue
    }
    if (!ent.isFile()) continue
    if (ent.name !== 'index.js') continue
    out.push(abs)
  }
}

const files = []
walk(pagesDir, files)

const bad = []
for (const file of files) {
  const src = fs.readFileSync(file, 'utf8')
  if (/\bPage\s*\(/.test(src)) {
    bad.push(path.relative(root, file))
  }
}

if (bad.length > 0) {
  console.error('Found pages not using createPage:')
  for (const rel of bad) console.error(`- ${rel}`)
  process.exit(1)
}

console.log(`OK: ${files.length} pages use createPage.`)
