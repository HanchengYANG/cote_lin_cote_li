const { call } = require('../../../utils/api')
const { formatTime } = require('../../../utils/format')
const { decorateOrderSummary } = require('../../../utils/order-list')
const { createPage } = require('../../../utils/create-page')

createPage({
  data: {
    loading: false,
    loadPhase: 'loading',
    saleOptions: [{ label: '加载中...', value: '' }],
    saleIndex: 0,
    saleLabel: '加载中...',
    orders: [],
  },

  onShow() {
    this.init()
  },

  async init() {
    const dashRes = await call('admin', 'getDashboard')
    const salesRes = await call('admin', 'listSales', { limit: 20 })
    let sales = []
    if (salesRes.ok) sales = salesRes.data.sales || []

    const opts = sales.map((s) => ({
      label: `${s.status} ${formatTime(s.createdAt)}`,
      value: s._id,
    }))
    if (opts.length === 0) opts.push({ label: '暂无开单', value: '' })

    let saleIndex = 0
    if (dashRes.ok && dashRes.data.activeSale) {
      const activeId = dashRes.data.activeSale._id
      const idx = opts.findIndex((o) => o.value === activeId)
      saleIndex = idx >= 0 ? idx : 0
    }
    this.setData({ saleOptions: opts, saleIndex })
    this.recomputeLabels()
    this.reload()
  },

  onPickSale(e) {
    this.setData({ saleIndex: Number(e.detail.value || 0) })
    this.recomputeLabels()
    this.reload()
  },

  recomputeLabels() {
    const saleLabel =
      (this.data.saleOptions[this.data.saleIndex] && this.data.saleOptions[this.data.saleIndex].label) || '未选择'
    this.setData({ saleLabel })
  },

  async reload() {
    const finishLoadPhase = () => {
      if (this.data.loadPhase !== 'ready') {
        this.setData({ loadPhase: 'ready' })
      }
    }
    if (this.data.loadPhase !== 'ready') this.setData({ loadPhase: 'loading' })
    const saleId = this.data.saleOptions[this.data.saleIndex] && this.data.saleOptions[this.data.saleIndex].value
    if (!saleId) {
      this.setData({ orders: [] })
      finishLoadPhase()
      return
    }
    this.setData({ loading: true })
    const res = await call('admin', 'listOrders', { saleId })
    this.setData({ loading: false })
    finishLoadPhase()
    if (!res.ok) {
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }
    const raw = res.data.orders || []
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
    wx.navigateTo({ url: `/pages/admin/order-detail/index?orderId=${encodeURIComponent(id)}` })
  },
})
