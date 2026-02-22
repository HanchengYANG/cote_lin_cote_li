const { call } = require('../../utils/api')
const { decorateOrderSummary } = require('../../utils/order-list')
const { createPage } = require('../../utils/create-page')

createPage({
  data: {
    loading: false,
    initialLoading: true,
    initialLoaded: false,
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
    const finishInitialLoad = () => {
      if (this.data.initialLoading || !this.data.initialLoaded) {
        this.setData({ initialLoading: false, initialLoaded: true })
      }
    }
    const res = await call('customer', 'listMyOrders')
    this.setData({ loading: false })
    finishInitialLoad()
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
    const orders = raw.map(decorateOrderSummary)
    this.setData({ orders })
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/my-order-detail/index?orderId=${encodeURIComponent(id)}` })
  },
})
