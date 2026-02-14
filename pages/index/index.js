const { call } = require('../../utils/api')
const { centToEuro } = require('../../utils/format')
const { getSession } = require('../../utils/session')

const HOME_CACHE_KEY = 'home_bootstrap_cache_v4'

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
    profileSummary: {
      isComplete: false,
      nickname: '',
      addressCount: 0,
      defaultAddressId: '',
    },
    dishes: [],
    qtyMap: {},
    totalQty: 0,
    totalAmountEuro: '0.00',
    lastErrorMsg: '',
  },

  onLoad() {
    this._hasLoadedOnce = true
    this.bootstrap()
  },

  onShow() {
    if (!this._hasLoadedOnce) return
    if (this.data.isHydrating) return
    this.reload({ silent: true })
  },

  async bootstrap() {
    if (!wx.cloud) {
      this.reportError('请先启用云开发')
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
    this.applyBootstrap(cached.sale, cached.dishes, cached.profile || null)
  },

  applyBootstrap(rawSale, rawDishes, rawProfile) {
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
    const profileSummary = {
      isComplete: !!(rawProfile && rawProfile.isComplete),
      nickname: String((rawProfile && rawProfile.nickname) || ''),
      addressCount: Number((rawProfile && rawProfile.addressCount) || 0),
      defaultAddressId: String((rawProfile && rawProfile.defaultAddressId) || ''),
    }
    this.setData({
      saleInfo,
      profileSummary,
      dishes: sorted,
      qtyMap,
      totalQty,
      totalAmountEuro: centToEuro(totalAmountCents),
      isHydrating: false,
      lastErrorMsg: '',
    })
  },

  reportError(message, detail) {
    const msg = String(message || '未知错误')
    const now = new Date()
    const hh = `${now.getHours()}`.padStart(2, '0')
    const mm = `${now.getMinutes()}`.padStart(2, '0')
    const ss = `${now.getSeconds()}`.padStart(2, '0')
    const stamped = `[${hh}:${mm}:${ss}] ${msg}`
    this.setData({ lastErrorMsg: stamped })
    // eslint-disable-next-line no-console
    console.error('[index]', msg, detail || '')
    wx.showToast({ title: msg, icon: 'none', duration: 5000 })
  },

  clearError() {
    this.setData({ lastErrorMsg: '' })
  },

  async reload(options = {}) {
    const silent = !!options.silent
    if (!silent) this.setData({ refresherTriggered: true })
    const res = await call('customer', 'bootstrapHome')
    if (!silent) this.setData({ refresherTriggered: false })
    if (!res.ok) {
      this.setData({ isHydrating: false })
      this.reportError(res.message || '加载菜单失败', res)
      return
    }
    const sale = (res.data && res.data.sale) || { isOpen: false, saleId: '', deliveryTimeSlotLabel: '' }
    const dishes = (res.data && res.data.dishes) || []
    const profile = (res.data && res.data.profile) || null
    this.applyBootstrap(sale, dishes, profile)
    wx.setStorageSync(HOME_CACHE_KEY, {
      updatedAt: Date.now(),
      sale,
      dishes,
      profile,
    })
    const isComplete = !!(profile && profile.isComplete)
    if (!isComplete && !this._profileRedirecting) {
      this._profileRedirecting = true
      wx.navigateTo({
        url: '/pages/profile-setup/index?from=index',
        complete: () => {
          this._profileRedirecting = false
        },
      })
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
    if (!this.data.profileSummary || !this.data.profileSummary.isComplete) {
      wx.navigateTo({ url: '/pages/profile-setup/index?from=checkout' })
      return
    }
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
