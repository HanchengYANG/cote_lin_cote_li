function pad2(n) {
  return n < 10 ? `0${n}` : `${n}`
}

function formatTime(ts) {
  if (!ts) return ''
  const d = typeof ts === 'number' ? new Date(ts) : new Date(String(ts))
  if (Number.isNaN(d.getTime())) return ''
  const Y = d.getFullYear()
  const M = pad2(d.getMonth() + 1)
  const D = pad2(d.getDate())
  const h = pad2(d.getHours())
  const m = pad2(d.getMinutes())
  return `${Y}-${M}-${D} ${h}:${m}`
}

function centToEuro(cents) {
  const n = Number(cents || 0)
  return (n / 100).toFixed(2)
}

function euroToCent(str) {
  const s = String(str || '').trim().replace(',', '.')
  if (!s) return 0
  const n = Number(s)
  if (Number.isNaN(n)) return 0
  return Math.round(n * 100)
}

module.exports = {
  formatTime,
  centToEuro,
  euroToCent,
}
