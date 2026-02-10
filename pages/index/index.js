const { call } = require('../../utils/api')
const { fenToYuan } = require('../../utils/format')

function calcTotals(dishes, qtyMap) {
  let totalQty = 0
  let totalAmountFen = 0
  for (const d of dishes) {
    const q = Number(qtyMap[d._id] || 0)
    if (q > 0) {
      totalQty += q
      totalAmountFen += q * Number(d.priceFen || 0)
    }
  }
  return { totalQty, totalAmountFen }
}

Page({
  data: {
    refresherTriggered: false,
    isAdmin: false,
    sale: null,
    dishes: [],
    qtyMap: {},
    totalQty: 0,
    totalAmountYuan: '0.00',
  },

  onLoad() {
    this.reload()
  },

  async reload() {
    if (!wx.cloud) {
      wx.showToast({ title: '请先启用云开发', icon: 'none' })
      return
    }
    this.setData({ refresherTriggered: true })

    const [adminRes, saleRes] = await Promise.all([
      call('auth', 'isAdmin'),
      call('customer', 'getCurrentSale'),
    ])

    const isAdmin = !!(adminRes && adminRes.ok && adminRes.data && adminRes.data.isAdmin)
    let sale = null
    let dishes = []
    if (saleRes && saleRes.ok && saleRes.data && saleRes.data.sale) {
      sale = saleRes.data.sale
      dishes = (saleRes.data.dishes || []).map((d) => ({
        ...d,
        priceYuan: fenToYuan(d.priceFen),
        qty: 0,
      }))
    }

    const prevSaleId = this.data.sale && this.data.sale._id
    const nextSaleId = sale && sale._id

    let qtyMap = {}
    if (prevSaleId && nextSaleId && prevSaleId === nextSaleId) {
      qtyMap = { ...this.data.qtyMap }
      dishes = dishes.map((d) => ({ ...d, qty: Number(qtyMap[d._id] || 0) }))
    }

    const { totalQty, totalAmountFen } = calcTotals(dishes, qtyMap)

    this.setData({
      isAdmin,
      sale,
      dishes,
      qtyMap,
      totalQty,
      totalAmountYuan: fenToYuan(totalAmountFen),
      refresherTriggered: false,
    })

    // If sale changed, clear cart.
    const stored = wx.getStorageSync('checkout_cart')
    if (stored && stored.saleId && sale && stored.saleId !== sale._id) {
      wx.removeStorageSync('checkout_cart')
      this.setData({ qtyMap: {}, dishes: dishes.map((d) => ({ ...d, qty: 0 })), totalQty: 0, totalAmountYuan: '0.00' })
    }
  },

  onPullDownRefresh() {
    this.reload().finally(() => {
      wx.stopPullDownRefresh()
    })
  },

  inc(e) {
    const id = e.currentTarget.dataset.id
    this.bumpQty(id, +1)
  },

  dec(e) {
    const id = e.currentTarget.dataset.id
    this.bumpQty(id, -1)
  },

  bumpQty(id, delta) {
    const dishes = this.data.dishes.map((d) => {
      if (d._id !== id) return d
      const next = Math.max(0, Number(d.qty || 0) + delta)
      return { ...d, qty: next }
    })
    const qtyMap = {}
    for (const d of dishes) qtyMap[d._id] = Number(d.qty || 0)
    const { totalQty, totalAmountFen } = calcTotals(dishes, qtyMap)
    this.setData({ dishes, qtyMap, totalQty, totalAmountYuan: fenToYuan(totalAmountFen) })
  },

  goCheckout() {
    if (!this.data.sale) return
    const items = []
    for (const d of this.data.dishes) {
      const qty = Number(d.qty || 0)
      if (qty > 0) items.push({ dishId: d._id, qty })
    }
    wx.setStorageSync('checkout_cart', {
      saleId: this.data.sale._id,
      items,
    })
    wx.navigateTo({ url: '/pages/checkout/index' })
  },

  goMyOrders() {
    wx.navigateTo({ url: '/pages/my-orders/index' })
  },

  goAdminHome() {
    wx.navigateTo({ url: '/pages/admin/home/index' })
  },

  goAdminSaleDraft() {
    wx.navigateTo({ url: '/pages/admin/sale-draft/index' })
  },
})
