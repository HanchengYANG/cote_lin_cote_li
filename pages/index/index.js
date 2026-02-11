const { call } = require('../../utils/api')
const { centToEuro } = require('../../utils/format')
const { getSession } = require('../../utils/session')

const HOME_CACHE_KEY = 'home_bootstrap_cache_v3'

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

function normalizeDishes(input) {
  return Array.isArray(input) ? input.filter((x) => x && x._id) : []
}

function sortDishesBySaleState(dishes, saleInfo) {
  if (!saleInfo || !saleInfo.isOpen) return dishes
  const sorted = [...dishes]
  sorted.sort((a, b) => {
    const rankA = Number(a.statusRank || 0)
    const rankB = Number(b.statusRank || 0)
    if (rankA !== rankB) return rankA - rankB
    const nameA = String(a.name || '')
    const nameB = String(b.name || '')
    return nameA.localeCompare(nameB)
  })
  return sorted
}

Page({
  data: {
    refresherTriggered: false,
    isAdmin: false,
    isHydrating: true,
    saleInfo: {
      isOpen: false,
      saleId: '',
      deliveryTimeSlotLabel: '',
    },
    dishes: [],
    qtyMap: {},
    totalQty: 0,
    totalAmountEuro: '0.00',
  },

  onLoad() {
    this.bootstrap()
  },

  async bootstrap() {
    if (!wx.cloud) {
      wx.showToast({ title: '请先启用云开发', icon: 'none' })
      return
    }
    this.hydrateFromCache()
    const sess = await getSession()
    this.setData({ isAdmin: !!(sess && sess.isAdmin) })
    await this.reload({ silent: this.data.dishes.length > 0 })
  },

  hydrateFromCache() {
    const cached = wx.getStorageSync(HOME_CACHE_KEY)
    if (!cached || !Array.isArray(cached.dishes) || !cached.sale) return
    this.applyBootstrap(cached.sale, cached.dishes)
  },

  applyBootstrap(rawSale, rawDishes) {
    const prevQtyMap = { ...(this.data.qtyMap || {}) }
    const saleInfo = {
      isOpen: !!(rawSale && rawSale.isOpen),
      saleId: String((rawSale && rawSale.saleId) || ''),
      deliveryTimeSlotLabel: String((rawSale && rawSale.deliveryTimeSlotLabel) || ''),
    }
    const dishes = normalizeDishes(rawDishes).map((d) => {
      const inSale = !!d.inSale
      const isSoldOut = !!d.isSoldOut
      const isOpen = !!saleInfo.isOpen
      const canAdd = !isOpen || (inSale && !isSoldOut)
      const statusText = isOpen ? (inSale ? (isSoldOut ? '售罄' : '可下单') : '本次不卖') : '未开单'
      const statusClass = isOpen ? (inSale ? (isSoldOut ? 'sold-out' : 'ok') : 'closed') : 'not-open'
      const statusRank = isOpen ? (inSale ? (isSoldOut ? 1 : 0) : 2) : 0
      const qty = Math.max(0, Number(prevQtyMap[d._id] || 0))
      return {
        ...d,
        priceEuro: centToEuro(d.priceCents || 0),
        thumb: d.thumbUrl || '',
        descPlain: d.descPlain || '',
        inSale,
        isSoldOut,
        canAdd,
        statusText,
        statusClass,
        statusRank,
        qty,
      }
    })
    const sorted = sortDishesBySaleState(dishes, saleInfo)
    const qtyMap = {}
    for (const d of sorted) qtyMap[d._id] = Number(d.qty || 0)
    const { totalQty, totalAmountCents } = calcTotals(sorted, qtyMap)
    this.setData({
      saleInfo,
      dishes: sorted,
      qtyMap,
      totalQty,
      totalAmountEuro: centToEuro(totalAmountCents),
      isHydrating: false,
    })
  },

  async reload(options = {}) {
    const silent = !!options.silent
    if (!silent) this.setData({ refresherTriggered: true })
    const res = await call('customer', 'bootstrapHome')
    if (!silent) this.setData({ refresherTriggered: false })
    if (!res.ok) {
      this.setData({ isHydrating: false })
      wx.showToast({ title: res.message || '加载菜单失败', icon: 'none' })
      return
    }
    const sale = (res.data && res.data.sale) || { isOpen: false, saleId: '', deliveryTimeSlotLabel: '' }
    const dishes = (res.data && res.data.dishes) || []
    this.applyBootstrap(sale, dishes)
    wx.setStorageSync(HOME_CACHE_KEY, {
      updatedAt: Date.now(),
      sale,
      dishes,
    })
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
    const saleOpen = !!(this.data.saleInfo && this.data.saleInfo.isOpen)
    let hitStockLimit = false
    const dishes = this.data.dishes.map((d) => {
      if (d._id !== id) return d
      if (delta > 0 && !d.canAdd) return d
      const current = Math.max(0, Number(d.qty || 0))
      let next = Math.max(0, current + delta)
      if (delta > 0 && saleOpen && d.inSale) {
        const remaining = Math.max(0, Number(d.remainingQty || 0))
        if (next > remaining) {
          next = remaining
          if (next === current) hitStockLimit = true
        }
      }
      return { ...d, qty: next }
    })
    const qtyMap = {}
    for (const d of dishes) qtyMap[d._id] = Number(d.qty || 0)
    const { totalQty, totalAmountCents } = calcTotals(dishes, qtyMap)
    this.setData({
      dishes,
      qtyMap,
      totalQty,
      totalAmountEuro: centToEuro(totalAmountCents),
    })
    if (hitStockLimit) {
      wx.showToast({ title: '库存不足', icon: 'none' })
    }
  },

  goCheckout() {
    const items = []
    for (const d of this.data.dishes) {
      const qty = Number(d.qty || 0)
      if (qty <= 0) continue
      items.push({
        dishId: d._id,
        qty,
        name: d.name,
        priceCents: Number(d.priceCents || 0),
      })
    }
    if (items.length === 0) return
    wx.setStorageSync('checkout_cart', {
      items,
      updatedAt: Date.now(),
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
