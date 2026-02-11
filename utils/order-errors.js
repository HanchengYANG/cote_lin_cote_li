function outOfStockMessage(detail, fallback = '库存不足，请调整后重试') {
  const list = detail && Array.isArray(detail.items) ? detail.items : []
  if (list.length === 0) return fallback
  const first = list[0]
  const name = String((first && first.dishName) || '')
  const remain = Number(first && first.remainingQty)
  if (name && Number.isFinite(remain)) return `${name} 库存不足（剩余 ${Math.max(0, remain)}）`
  if (name) return `${name} 库存不足`
  return fallback
}

module.exports = {
  outOfStockMessage,
}
