const { call } = require('../../../utils/api')
const { formatTime } = require('../../../utils/format')
const { getSession } = require('../../../utils/session')
const { getSnapshot, invalidateSnapshot } = require('../../../utils/app-snapshot')
const { createPage } = require('../../../utils/create-page')

createPage({
  data: {
    refresherTriggered: false,
    authKnown: false,
    isAdmin: false,
    myOpenId: '',
    activeSale: null,
    stats: { orderCount: 0 },
    sales: [],
    saleKnown: false,
  },

  onLoad() {
    this.hydrateFromSnapshot()
    this.reload({ silent: true })
  },

  hydrateFromSnapshot() {
    const snapshot = getSnapshot()
    const sale = snapshot && snapshot.sale
    if (!sale) return
    const isOpen = !!sale.isOpen
    this.setData({
      activeSale: isOpen
        ? {
            _id: String(sale.saleId || sale._id || ''),
            status: 'OPEN',
            deliveryTimeSlotLabel: String(sale.deliveryTimeSlotLabel || ''),
          }
        : null,
      saleKnown: true,
    })
  },

  async reload(options = {}) {
    const silent = !!options.silent
    if (!silent) this.setData({ refresherTriggered: true })
    try {
      const sess = await getSession()
      const isAdmin = !!sess.isAdmin
      const myOpenId = sess.openId || ''
      this.setData({ authKnown: true, isAdmin, myOpenId })
      if (!isAdmin) {
        this.setData({ activeSale: null, stats: { orderCount: 0 }, sales: [], saleKnown: true })
        return
      }

      const [dashRes, salesRes] = await Promise.all([
        call('admin', 'getDashboard'),
        call('admin', 'listSales', { limit: 20 }),
      ])
      if (dashRes.ok) {
        this.setData({
          activeSale: dashRes.data.activeSale || null,
          stats: dashRes.data.stats || { orderCount: 0 },
          saleKnown: true,
        })
      } else if (!this.data.saleKnown) {
        this.setData({ saleKnown: true })
      }
      if (salesRes.ok) {
        const sales = (salesRes.data.sales || []).map((s) => ({
          ...s,
          createdAtText: formatTime(s.createdAt),
        }))
        this.setData({ sales })
      }
    } finally {
      if (!silent) this.setData({ refresherTriggered: false })
    }
  },

  onPullDownRefresh() {
    this.reload().finally(() => {
      wx.stopPullDownRefresh()
    })
  },

  copyOpenId() {
    wx.setClipboardData({ data: this.data.myOpenId })
  },

  goDishes() {
    wx.navigateTo({ url: '/pages/admin/dishes/index' })
  },

  goSaleDraft() {
    wx.navigateTo({ url: '/pages/admin/sale-draft/index' })
  },

  goOrders() {
    wx.navigateTo({ url: '/pages/admin/orders/index' })
  },

  goActiveSaleEdit() {
    wx.navigateTo({ url: '/pages/admin/sale-active-edit/index' })
  },

  goExport() {
    wx.navigateTo({ url: '/pages/admin/export/index' })
  },

  goDeliveryRules() {
    wx.navigateTo({ url: '/pages/admin/delivery-rules/index' })
  },

  goExportWithSale(e) {
    const saleId = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/admin/export/index?saleId=${encodeURIComponent(saleId)}` })
  },

  async closeSale() {
    const sale = this.data.activeSale
    if (!sale) return
    wx.showModal({
      title: '确认截单',
      content: '截单后顾客无法再下单。',
      success: async (r) => {
        if (!r.confirm) return
        const res = await call('admin', 'closeSale', { saleId: sale._id })
        if (!res.ok) {
          wx.showToast({ title: res.message || '截单失败', icon: 'none' })
          return
        }
        invalidateSnapshot()
        wx.showToast({ title: '已截单', icon: 'success' })
        this.reload()
      },
    })
  },
})
