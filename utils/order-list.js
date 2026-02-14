const { formatTime, centToEuro } = require('./format')

function formatAddress(a) {
  if (!a) return ''
  return [a.line1, a.line2, a.postalCode, a.city, a.country].filter(Boolean).join(', ')
}

function decorateOrderSummary(order) {
  if (!order) return null
  let statusText = '有效'
  let statusClass = 'ok'
  if (order.status === 'CANCELLED') {
    statusText = '已取消'
    statusClass = 'cancel'
  } else if (order.status === 'PENDING_REVIEW') {
    statusText = '待确认'
    statusClass = 'pending'
  } else if (order.status === 'REJECTED') {
    statusText = '已拒绝'
    statusClass = 'cancel'
  }
  const fulfillmentText = order.fulfillmentType === 'pickup' ? '自取' : '配送'
  const totals = order.totals || { amountCents: 0, qty: 0 }
  const customerNameText = String(order.customerNickname || '').trim() || '匿名用户'
  const phoneText = String((order.contact && order.contact.phone) || '').trim() || '-'
  const addressText = formatAddress(order.address)
  return {
    ...order,
    statusText,
    statusClass,
    fulfillmentText,
    customerNameText,
    phoneText,
    addressText,
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
