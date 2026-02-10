const { call } = require('../../utils/api')
const { formatTime, fenToYuan } = require('../../utils/format')

function decorateOrder(o) {
  const statusText = o.status === 'CANCELLED' ? '已取消' : '有效'
  const statusClass = o.status === 'CANCELLED' ? 'cancel' : 'ok'
  const fulfillmentText = o.fulfillmentType === 'pickup' ? '自取' : '配送'
  const totals = o.totals || { amountFen: 0, qty: 0 }
  return {
    ...o,
    statusText,
    statusClass,
    fulfillmentText,
    createdAtText: formatTime(o.createdAt),
    totals: {
      qty: totals.qty || 0,
      amountYuan: fenToYuan(totals.amountFen || 0),
    },
  }
}

Page({
  data: {
    loading: false,
    orders: [],
  },

  onLoad() {
    this.reload()
  },

  onPullDownRefresh() {
    this.reload().finally(() => wx.stopPullDownRefresh())
  },

  async reload() {
    this.setData({ loading: true })
    const res = await call('customer', 'listMyOrders')
    this.setData({ loading: false })
    if (!res.ok) {
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }
    const raw = (res.data && res.data.orders) ? res.data.orders : []
    raw.sort((a, b) => {
      const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
      const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
      return tb - ta
    })
    const orders = raw.map(decorateOrder)
    this.setData({ orders })
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/my-order-detail/index?orderId=${encodeURIComponent(id)}` })
  },
})
