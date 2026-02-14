const { formatTime, centToEuro } = require('./format')
const { outOfStockMessage: buildOutOfStockMessage } = require('./order-errors')

function formatAddress(addr) {
  if (!addr) return ''
  const parts = [addr.line1, addr.line2, addr.postalCode, addr.city, addr.country].filter(Boolean)
  return parts.join(' ')
}

function decorateOrder(order) {
  if (!order) return null
  let statusText = '有效'
  if (order.status === 'CANCELLED') statusText = '已取消'
  if (order.status === 'PENDING_REVIEW') statusText = '待确认'
  if (order.status === 'REJECTED') statusText = '已拒绝'
  const fulfillmentText = order.fulfillmentType === 'pickup' ? '自取' : '配送'
  const items = (order.items || []).map((it) => ({
    ...it,
    lineTotalEuro: centToEuro(it.lineTotalCents || 0),
  }))
  const totals = order.totals || { amountCents: 0, qty: 0 }
  return {
    ...order,
    statusText,
    fulfillmentText,
    createdAtText: formatTime(order.createdAt),
    addressText: formatAddress(order.address),
    items,
    totals: {
      qty: totals.qty || 0,
      amountEuro: centToEuro(totals.amountCents || 0),
    },
  }
}

function buildEditableItems(order) {
  const src = (order && Array.isArray(order.items)) ? order.items : []
  return src.map((it) => {
    const unitPriceCents = Number(it.unitPriceCents || 0)
    const qty = Number(it.qty || 0)
    return {
      dishId: it.dishId,
      dishName: it.dishName,
      unitPriceCents,
      unitPriceEuro: centToEuro(unitPriceCents),
      qty,
      lineTotalEuro: centToEuro(unitPriceCents * qty),
    }
  })
}

function calcEditableTotals(items) {
  let qty = 0
  let amountCents = 0
  for (const it of (items || [])) {
    const q = Number(it.qty || 0)
    const p = Number(it.unitPriceCents || 0)
    if (q <= 0 || !Number.isFinite(p)) continue
    qty += q
    amountCents += q * p
  }
  return {
    qty,
    amountEuro: centToEuro(amountCents),
  }
}

function applyQtyDelta(items, dishId, delta) {
  return (items || []).map((it) => {
    if (it.dishId !== dishId) return it
    const nextQty = Math.max(0, Number(it.qty || 0) + Number(delta || 0))
    return {
      ...it,
      qty: nextQty,
      lineTotalEuro: centToEuro(Number(it.unitPriceCents || 0) * nextQty),
    }
  })
}

function removeDish(items, dishId) {
  return (items || []).map((it) => {
    if (it.dishId !== dishId) return it
    return {
      ...it,
      qty: 0,
      lineTotalEuro: '0.00',
    }
  })
}

function buildPayloadItems(items) {
  return (items || []).map((it) => ({
    dishId: it.dishId,
    qty: Number(it.qty || 0),
  }))
}

function outOfStockMessage(detail) {
  return buildOutOfStockMessage(detail, '库存不足，请调整后重试')
}

module.exports = {
  formatAddress,
  decorateOrder,
  buildEditableItems,
  calcEditableTotals,
  applyQtyDelta,
  removeDish,
  buildPayloadItems,
  outOfStockMessage,
}
