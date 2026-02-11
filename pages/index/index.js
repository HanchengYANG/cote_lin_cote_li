const { call } = require('../../utils/api')
const { centToEuro } = require('../../utils/format')
const { getSession } = require('../../utils/session')

function calcTotals(dishes, qtyMap) {
  let totalQty = 0
  let totalAmountCents = 0
  for (const d of dishes) {
    const q = Number(qtyMap[d._id] || 0)
    if (q > 0) {
      totalQty += q
      totalAmountCents += q * Number(d.priceCents || 0)
    }
  }
  return { totalQty, totalAmountCents }
}

Page({
  data: {
    refresherTriggered: false,
    isAdmin: false,
    sale: null,
    hasExistingOrder: false,
    dishes: [],
    qtyMap: {},
    totalQty: 0,
    totalAmountEuro: '0.00',
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

    const [sess, saleRes] = await Promise.all([
      getSession(),
      call('customer', 'getCurrentSale'),
    ])

    const isAdmin = !!(sess && sess.isAdmin)
    let sale = null
    let dishes = []
    let hasExistingOrder = false
    if (saleRes && saleRes.ok && saleRes.data && saleRes.data.sale) {
      sale = saleRes.data.sale
      dishes = (saleRes.data.dishes || []).map((d) => ({
        ...d,
        priceEuro: centToEuro(d.priceCents),
        thumb: d.thumbUrl || '',
        descPlain: d.descPlain || '',
        qty: 0,
      }))
      const orderRes = await call('customer', 'getMySaleOrder', { saleId: sale._id })
      hasExistingOrder = !!(orderRes.ok && orderRes.data && orderRes.data.order)
    }

    const prevSaleId = this.data.sale && this.data.sale._id
    const nextSaleId = sale && sale._id

    let qtyMap = {}
    if (prevSaleId && nextSaleId && prevSaleId === nextSaleId) {
      qtyMap = { ...this.data.qtyMap }
      dishes = dishes.map((d) => {
        const remain = Number(d.remainingQty)
        const maxQty = Number.isFinite(remain) ? Math.max(0, remain) : 999999
        const nextQty = Math.min(Number(qtyMap[d._id] || 0), maxQty)
        qtyMap[d._id] = nextQty
        return { ...d, qty: nextQty }
      })
    }

    const { totalQty, totalAmountCents } = calcTotals(dishes, qtyMap)

    this.setData({
      isAdmin,
      sale,
      hasExistingOrder,
      dishes,
      qtyMap,
      totalQty,
      totalAmountEuro: centToEuro(totalAmountCents),
      refresherTriggered: false,
    })

    // If sale changed, clear cart.
    const stored = wx.getStorageSync('checkout_cart')
    if (stored && stored.saleId && sale && stored.saleId !== sale._id) {
      wx.removeStorageSync('checkout_cart')
      this.setData({ qtyMap: {}, dishes: dishes.map((d) => ({ ...d, qty: 0 })), totalQty: 0, totalAmountEuro: '0.00' })
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
    const target = (this.data.dishes || []).find((d) => d._id === id)
    if (delta > 0 && target && target.isSoldOut) return
    const dishes = this.data.dishes.map((d) => {
      if (d._id !== id) return d
      const remain = Number(d.remainingQty)
      const maxQty = Number.isFinite(remain) ? Math.max(0, remain) : 999999
      const next = Math.max(0, Math.min(maxQty, Number(d.qty || 0) + delta))
      return { ...d, qty: next }
    })
    const qtyMap = {}
    for (const d of dishes) qtyMap[d._id] = Number(d.qty || 0)
    const { totalQty, totalAmountCents } = calcTotals(dishes, qtyMap)
    this.setData({ dishes, qtyMap, totalQty, totalAmountEuro: centToEuro(totalAmountCents) })
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

  goDishDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: `/pages/dish-detail/index?dishId=${encodeURIComponent(id)}` })
  },
})
