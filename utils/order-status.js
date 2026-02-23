function normalizeOrderStatus(input) {
  return String(input || '').trim().toUpperCase()
}

function normalizePaidStatus(input) {
  return String(input || '').trim().toUpperCase() === 'PAID' ? 'PAID' : 'UNPAID'
}

function normalizeHandoffStatus(input) {
  return String(input || '').trim().toUpperCase() === 'DELIVERED' ? 'DELIVERED' : 'PENDING'
}

function getOrderMainStatus(order) {
  const orderStatus = normalizeOrderStatus(order && order.status)
  const paidStatus = normalizePaidStatus(order && order.payment && order.payment.paidStatus)
  const handoffStatus = normalizeHandoffStatus(order && order.handoffStatus)

  if (orderStatus === 'CANCELLED') {
    return { code: 'CANCELLED', text: '已取消', className: 'cancel' }
  }
  if (orderStatus === 'REJECTED') {
    return { code: 'REJECTED', text: '已拒绝', className: 'reject' }
  }
  if (orderStatus === 'PENDING_REVIEW') {
    return { code: 'PENDING_REVIEW', text: '待确认', className: 'pending' }
  }

  if (orderStatus === 'ACTIVE') {
    const delivered = handoffStatus === 'DELIVERED'
    const paid = paidStatus === 'PAID'
    if (delivered && paid) {
      return { code: 'COMPLETED', text: '已完成', className: 'done' }
    }
    if (delivered) {
      return { code: 'DELIVERED', text: '已送达', className: 'delivered' }
    }
    if (paid) {
      return { code: 'PAID', text: '已付款', className: 'paid' }
    }
    return { code: 'ACTIVE', text: '有效', className: 'ok' }
  }

  return { code: orderStatus || 'UNKNOWN', text: '未知状态', className: 'pending' }
}

module.exports = {
  getOrderMainStatus,
}

