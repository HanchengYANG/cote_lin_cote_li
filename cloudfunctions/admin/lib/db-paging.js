async function getAllByPaging(buildQuery, options = {}) {
  const pageSize = Math.max(1, Math.min(100, Number(options.pageSize || 100)))
  const out = []
  let skip = 0
  while (true) {
    const q = buildQuery(skip, pageSize)
    const r = await q.get()
    const rows = (r && r.data) || []
    out.push(...rows)
    if (rows.length < pageSize) break
    skip += rows.length
  }
  return out
}

module.exports = {
  getAllByPaging,
}
