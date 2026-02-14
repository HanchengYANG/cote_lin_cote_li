const { call } = require('../../../utils/api')
const { formatTime } = require('../../../utils/format')
const { getSession } = require('../../../utils/session')

Page({
  data: {
    isAdmin: false,
    myOpenId: '',
    activeSale: null,
    stats: { orderCount: 0 },
    sales: [],
  },

  onShow() {
    this.reload()
  },

  async reload() {
    const sess = await getSession()
    const isAdmin = !!sess.isAdmin
    const myOpenId = sess.openId || ''
    this.setData({ isAdmin, myOpenId })
    if (!isAdmin) {
      this.setData({ activeSale: null, stats: { orderCount: 0 }, sales: [] })
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
      })
    }
    if (salesRes.ok) {
      const sales = (salesRes.data.sales || []).map((s) => ({
        ...s,
        createdAtText: formatTime(s.createdAt),
      }))
      this.setData({ sales })
    }
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
        wx.showToast({ title: '已截单', icon: 'success' })
        this.reload()
      },
    })
  },
})
