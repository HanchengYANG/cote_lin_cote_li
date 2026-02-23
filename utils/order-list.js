const { formatTime, centToEuro } = require('./format')
const { getOrderMainStatus } = require('./order-status')

function formatAddress(a) {
  if (!a) return ''
  return [a.line1, a.line2, a.postalCode, a.city, a.country].filter(Boolean).join(', ')
}

function decorateOrderSummary(order) {
  if (!order) return null
  const mainStatus = getOrderMainStatus(order)
  const fulfillmentText = order.fulfillmentType === 'pickup' ? '自取' : '配送'
  const totals = order.totals || { amountCents: 0, qty: 0 }
  const customerNameText = String(order.customerNickname || '').trim() || '匿名用户'
  const phoneText = String((order.contact && order.contact.phone) || '').trim() || '-'
  const addressText = formatAddress(order.address)
  return {
    ...order,
    statusText: mainStatus.text,
    statusClass: mainStatus.className,
    statusCode: mainStatus.code,
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
