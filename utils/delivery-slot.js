function parseSlotLabel(label) {
  const s = String(label || '').trim()
  const m = s.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})-(\d{2}:\d{2})$/)
  if (!m) return null
  return {
    slotDate: m[1],
    slotStart: m[2],
    slotEnd: m[3],
  }
}

function buildSlotLabel(slotDate, slotStart, slotEnd) {
  const d = String(slotDate || '').trim()
  const s = String(slotStart || '').trim()
  const e = String(slotEnd || '').trim()
  if (!d || !s || !e) return ''
  return `${d} ${s}-${e}`
}

module.exports = {
  parseSlotLabel,
  buildSlotLabel,
}
