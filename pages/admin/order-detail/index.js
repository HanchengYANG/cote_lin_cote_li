const { call } = require('../../../utils/api')
const { formatTime, fenToYuan } = require('../../../utils/format')

function formatAddress(addr) {
  if (!addr) return ''
  const parts = [addr.province, addr.city, addr.district, addr.detail, addr.extra].filter(Boolean)
  return parts.join('')
}

function decorateOrder(o) {
  const statusText = o.status === 'CANCELLED' ? '已取消' : '有效'
  const fulfillmentText = o.fulfillmentType === 'pickup' ? '自取' : '配送'
  const items = (o.items || []).map((it) => ({ ...it, lineTotalYuan: fenToYuan(it.lineTotalFen || 0) }))
  const totals = o.totals || { amountFen: 0, qty: 0 }
  return {
    ...o,
    statusText,
    fulfillmentText,
    createdAtText: formatTime(o.createdAt),
    addressText: formatAddress(o.address),
    items,
    totals: { qty: totals.qty || 0, amountYuan: fenToYuan(totals.amountFen || 0) },
  }
}

Page({
  data: {
    orderId: '',
    order: null,
  },

  onLoad(query) {
    const orderId = (query && query.orderId) || ''
    this.setData({ orderId })
    this.reload()
  },

  async reload() {
    const res = await call('admin', 'getOrderDetail', { orderId: this.data.orderId })
    if (!res.ok) {
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }
    const order = res.data && res.data.order
    this.setData({ order: order ? decorateOrder(order) : null })
  },

  cancel() {
    if (!this.data.order || this.data.order.status === 'CANCELLED') return
    wx.showModal({
      title: '确认取消订单',
      content: '取消后默认不计入统计导出。',
      success: async (r) => {
        if (!r.confirm) return
        const res = await call('admin', 'cancelOrder', { orderId: this.data.orderId })
        if (!res.ok) {
          wx.showToast({ title: res.message || '取消失败', icon: 'none' })
          return
        }
        wx.showToast({ title: '已取消', icon: 'success' })
        this.reload()
      },
    })
  },
})

