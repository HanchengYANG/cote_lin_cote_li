const { formatTime, centToEuro } = require('./format')

function decorateOrderSummary(order) {
  if (!order) return null
  const statusText = order.status === 'CANCELLED' ? '已取消' : '有效'
  const statusClass = order.status === 'CANCELLED' ? 'cancel' : 'ok'
  const fulfillmentText = order.fulfillmentType === 'pickup' ? '自取' : '配送'
  const totals = order.totals || { amountCents: 0, qty: 0 }
  return {
    ...order,
    statusText,
    statusClass,
    fulfillmentText,
    createdAtText: formatTime(order.createdAt),
    totals: {
      qty: totals.qty || 0,
      amountEuro: centToEuro(totals.amountCents || 0),
    },
  }
}

module.exports = {
  decorateOrderSummary,
}
