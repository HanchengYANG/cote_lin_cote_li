function normalizeText(input, fallback = '') {
  const text = String(input == null ? '' : input)
  const clean = text.replace(/\r/g, '')
  if (clean) return clean
  return String(fallback || '')
}

function truncateToWidth(doc, input, maxWidth, suffix = '...') {
  const text = normalizeText(input)
  const width = Math.max(0, Number(maxWidth) || 0)
  if (!text || width <= 0) return ''
  if (doc.widthOfString(text) <= width) return text
  const chars = Array.from(text)
  const suffixText = String(suffix || '')
  const suffixWidth = suffixText ? doc.widthOfString(suffixText) : 0
  let out = ''
  for (let i = 0; i < chars.length; i += 1) {
    const next = out + chars[i]
    if (doc.widthOfString(next) + suffixWidth > width) break
    out = next
  }
  if (!out) return suffixWidth <= width ? suffixText : ''
  return `${out}${suffixText}`
}

function wrapTextLines(doc, input, maxWidth) {
  const width = Math.max(0, Number(maxWidth) || 0)
  if (width <= 0) return []
  const raw = normalizeText(input)
  if (!raw) return ['']
  const paragraphs = raw.split('\n')
  const out = []
  for (let p = 0; p < paragraphs.length; p += 1) {
    const paragraph = paragraphs[p]
    if (!paragraph) {
      out.push('')
      continue
    }
    let line = ''
    const chars = Array.from(paragraph)
    for (let i = 0; i < chars.length; i += 1) {
      const ch = chars[i]
      const next = line + ch
      if (!line || doc.widthOfString(next) <= width) {
        line = next
        continue
      }
      out.push(line)
      line = ch
      if (doc.widthOfString(line) > width) {
        out.push(truncateToWidth(doc, line, width, ''))
        line = ''
      }
    }
    if (line || paragraph.length === 0) out.push(line)
  }
  return out.length ? out : ['']
}

function clampLines(doc, lines, maxWidth, maxLines) {
  const src = Array.isArray(lines) ? lines.slice() : []
  const limit = Math.max(0, Number(maxLines) || 0)
  if (limit <= 0) return { lines: [], truncated: src.length > 0 }
  if (src.length <= limit) return { lines: src, truncated: false }
  const next = src.slice(0, limit)
  next[limit - 1] = truncateToWidth(doc, next[limit - 1], maxWidth, '...')
  return { lines: next, truncated: true }
}

function wrapAndClamp(doc, input, options = {}) {
  const maxWidth = Math.max(0, Number(options.maxWidth) || 0)
  const maxLines = Math.max(0, Number(options.maxLines) || 0)
  const lines = wrapTextLines(doc, input, maxWidth)
  return clampLines(doc, lines, maxWidth, maxLines)
}

function drawLines(doc, lines, rect, options = {}) {
  const x = Number(rect && rect.x) || 0
  const y = Number(rect && rect.y) || 0
  const width = Math.max(0, Number(rect && rect.width) || 0)
  const height = Math.max(0, Number(rect && rect.height) || 0)
  const lineHeight = Number(options.lineHeight) || 12
  const color = options.color || '#101828'
  const src = Array.isArray(lines) ? lines : []
  const maxRows = lineHeight > 0 ? Math.max(0, Math.floor((height + 0.1) / lineHeight)) : src.length
  const count = Math.min(src.length, maxRows)
  doc.fillColor(color)
  for (let i = 0; i < count; i += 1) {
    doc.text(src[i], x, y + i * lineHeight, {
      width,
      lineBreak: false,
    })
  }
  return count
}

module.exports = {
  normalizeText,
  truncateToWidth,
  wrapTextLines,
  clampLines,
  wrapAndClamp,
  drawLines,
}
