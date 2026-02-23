const { call } = require('../../../utils/api')
const { decorateOrderSummary } = require('../../../utils/order-list')
const { createPage } = require('../../../utils/create-page')

createPage({
  data: {
    loading: false,
    loadPhase: 'loading',
    orders: [],
  },

  onShow() {
    this.reload()
  },

  async reload() {
    if (this.data.loadPhase !== 'ready') this.setData({ loadPhase: 'loading' })
    this.setData({ loading: true })
    const res = await call('admin', 'listPendingOrders')
    this.setData({ loading: false })
    if (this.data.loadPhase !== 'ready') this.setData({ loadPhase: 'ready' })
    if (!res.ok) {
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }
    const raw = Array.isArray(res.data && res.data.orders) ? res.data.orders : []
    raw.sort((a, b) => {
      const ta = a && a.createdAt ? new Date(a.createdAt).getTime() : 0
      const tb = b && b.createdAt ? new Date(b.createdAt).getTime() : 0
      return tb - ta
    })
    const orders = raw.map(decorateOrderSummary).filter(Boolean)
    this.setData({ orders })
  },

  goDetail(e) {
    const id = String((e.currentTarget.dataset && e.currentTarget.dataset.id) || '').trim()
    if (!id) return
    wx.navigateTo({ url: `/pages/admin/order-detail/index?orderId=${encodeURIComponent(id)}` })
  },
})

