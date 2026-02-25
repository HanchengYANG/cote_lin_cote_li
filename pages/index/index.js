const { centToEuro } = require('../../utils/format')
const { call } = require('../../utils/api')
const { getSnapshot, ensureFresh, invalidateSnapshot } = require('../../utils/app-snapshot')
const { createPage } = require('../../utils/create-page')

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

function saleIsOpen(saleInfo) {
  return !!(saleInfo && String(saleInfo.status || '').trim() === 'OPEN')
}

function normalizeMyCurrentSaleOrder(raw) {
  if (!raw || typeof raw !== 'object') {
    return { hasActiveOrder: false, fulfillmentType: '' }
  }
  return {
    hasActiveOrder: !!raw.hasActiveOrder,
    fulfillmentType: String(raw.fulfillmentType || '').trim(),
  }
}

function buildCustomerOrderProgressText(saleInfo, myCurrentSaleOrder) {
  const saleStatus = String((saleInfo && saleInfo.status) || '').trim()
  const hasActiveOrder = !!(myCurrentSaleOrder && myCurrentSaleOrder.hasActiveOrder)
  if (!hasActiveOrder) return ''
  const fulfillmentType = String((myCurrentSaleOrder && myCurrentSaleOrder.fulfillmentType) || '').trim()
  if (saleStatus === 'OPEN') return '你已下单，可继续追加或修改订单。'
  if (saleStatus === 'CLOSED') return '你已下单，本次正在备餐中。'
  if (saleStatus === 'FULFILLING') {
    return fulfillmentType === 'pickup' ? '你已下单，可留意取餐通知。' : '你已下单，本次已开始配送。'
  }
  return ''
}

function shouldShowDeliverySlotForCurrentCustomer(saleInfo, myCurrentSaleOrder) {
  const label = String((saleInfo && saleInfo.deliveryTimeSlotLabel) || '').trim()
  if (!label) return false
  const hasActiveOrder = !!(myCurrentSaleOrder && myCurrentSaleOrder.hasActiveOrder)
  if (!hasActiveOrder) return false
  const fulfillmentType = String((myCurrentSaleOrder && myCurrentSaleOrder.fulfillmentType) || '').trim()
  return fulfillmentType === 'delivery'
}

function buildNoticePreview(note, maxLen = 26) {
  const full = String(note || '')
  const hasLineBreak = /\r?\n/.test(full)
  const compact = full.replace(/\s+/g, ' ').trim()
  if (!compact) return { text: '', canToggle: false }
  if (compact.length <= maxLen) {
    return { text: compact, canToggle: hasLineBreak }
  }
  return {
    text: `${compact.slice(0, maxLen).trim()}…`,
    canToggle: true,
  }
}

function buildNoticeLines(note) {
  return String(note || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
}

function sortDishesBySaleState(dishes, saleInfo) {
  if (!saleIsOpen(saleInfo)) return dishes
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

createPage({
  data: {
    refresherTriggered: false,
    isAdmin: false,
    isHydrating: true,
    saleInfo: {
      saleId: '',
      status: '',
      deliveryTimeSlotLabel: '',
      note: '',
    },
    profileSummary: {
      isComplete: false,
      nickname: '',
      addressCount: 0,
      defaultAddressId: '',
    },
    myCurrentSaleOrder: null,
    customerOrderProgressText: '',
    shouldShowDeliverySlot: false,
    dishes: [],
    qtyMap: {},
    totalQty: 0,
    totalAmountEuro: '0.00',
    lastErrorMsg: '',
    showNicknamePopup: false,
    nicknameDraft: '',
    nicknameSaving: false,
    nicknamePopupError: '',
    noticeCollapsed: true,
    noticePreviewText: '',
    noticeCanToggle: false,
    noticeLines: [],
  },

  onLoad() {
    this._hasLoadedOnce = true
    this.bootstrap()
  },

  onShow() {
    if (!this._hasLoadedOnce) return
    this.hydrateFromCache({ allowRedirect: true })
  },

  async bootstrap() {
    if (!wx.cloud) {
      this.reportError('请先启用云开发')
      return
    }
    const applied = this.hydrateFromCache({ allowRedirect: true })
    if (!applied) {
      await this.reload({ silent: true, allowRedirect: true })
      return
    }
  },

  hydrateFromCache(options = {}) {
    const cached = getSnapshot()
    if (!cached || !Array.isArray(cached.dishes) || !cached.sale) return false
    return this.applySnapshot(cached, options)
  },

  applySnapshot(snapshot, options = {}) {
    const rawProfile = snapshot.profile || null
    const profileSummary = {
      isComplete: !!(rawProfile && rawProfile.isComplete),
      nickname: String((rawProfile && rawProfile.nickname) || ''),
      addressCount: Number((rawProfile && rawProfile.addressCount) || 0),
      defaultAddressId: String((rawProfile && rawProfile.defaultAddressId) || ''),
    }
    this.applyBootstrap(snapshot.sale, snapshot.dishes, rawProfile, snapshot.session || null, snapshot.myCurrentSaleOrder || null)
    const patch = {
      showNicknamePopup: !profileSummary.isComplete,
    }
    if (profileSummary.isComplete) {
      patch.nicknameSaving = false
      patch.nicknamePopupError = ''
    } else if (!String(this.data.nicknameDraft || '').trim()) {
      patch.nicknameDraft = profileSummary.nickname
    }
    this.setData(patch)
    return true
  },

  applyBootstrap(rawSale, rawDishes, rawProfile, rawSession, rawMyCurrentSaleOrder) {
    const prevQtyMap = { ...(this.data.qtyMap || {}) }
    const saleInfo = {
      saleId: String((rawSale && rawSale.saleId) || ''),
      status: String((rawSale && rawSale.status) || ''),
      deliveryTimeSlotLabel: String((rawSale && rawSale.deliveryTimeSlotLabel) || ''),
      note: String((rawSale && rawSale.note) || '').trim(),
    }
    const dishes = normalizeDishes(rawDishes).map((d) => {
      const inSale = !!d.inSale
      const isSoldOut = !!d.isSoldOut
      const isOpen = saleIsOpen(saleInfo)
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
    const myCurrentSaleOrder = normalizeMyCurrentSaleOrder(rawMyCurrentSaleOrder)
    const customerOrderProgressText = buildCustomerOrderProgressText(saleInfo, myCurrentSaleOrder)
    const shouldShowDeliverySlot = shouldShowDeliverySlotForCurrentCustomer(saleInfo, myCurrentSaleOrder)
    const noticePreview = buildNoticePreview(saleInfo.note)
    const noticeLines = buildNoticeLines(saleInfo.note)
    this.setData({
      saleInfo,
      profileSummary,
      myCurrentSaleOrder,
      customerOrderProgressText,
      shouldShowDeliverySlot,
      noticePreviewText: noticePreview.text,
      noticeCanToggle: noticePreview.canToggle,
      noticeLines,
      dishes: sorted,
      qtyMap,
      totalQty,
      totalAmountEuro: centToEuro(totalAmountCents),
      isAdmin: !!(rawSession && rawSession.isAdmin),
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

  noop() {},

  toggleNoticeCollapsed() {
    this.setData({ noticeCollapsed: !this.data.noticeCollapsed })
  },

  onNicknamePopupInput(e) {
    const nicknameDraft = String((e && e.detail && e.detail.value) || '')
    const patch = { nicknameDraft }
    if (this.data.nicknamePopupError) patch.nicknamePopupError = ''
    this.setData(patch)
  },

  async saveNicknameFromPopup() {
    if (!this.data.showNicknamePopup || this.data.nicknameSaving) return
    const nickname = String(this.data.nicknameDraft || '').trim()
    if (!nickname) {
      this.setData({ nicknamePopupError: '请填写昵称' })
      return
    }
    this.setData({ nicknameSaving: true, nicknamePopupError: '' })
    const res = await call('customer', 'updateMyNickname', { nickname })
    if (!res.ok) {
      const msg = String(res.message || '保存失败')
      this.setData({
        nicknameSaving: false,
        nicknamePopupError: msg,
      })
      return
    }
    invalidateSnapshot()
    this.setData({
      nicknameSaving: false,
      nicknamePopupError: '',
      showNicknamePopup: false,
      profileSummary: {
        ...(this.data.profileSummary || {}),
        isComplete: true,
        nickname,
      },
    })
    wx.showToast({ title: '昵称已保存', icon: 'success' })
    await this.reload({ silent: true, allowRedirect: false })
  },

  async reload(options = {}) {
    const silent = !!options.silent
    const allowRedirect = options.allowRedirect !== false
    if (!silent) this.setData({ refresherTriggered: true })
    invalidateSnapshot()
    let snapshot = null
    try {
      snapshot = await ensureFresh()
    } catch (err) {
      snapshot = null
    }
    if (!silent) this.setData({ refresherTriggered: false })
    if (!snapshot) {
      this.setData({ isHydrating: false })
      this.reportError('加载菜单失败')
      return
    }
    this.applySnapshot(snapshot, { allowRedirect })
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
    const saleOpen = saleIsOpen(this.data.saleInfo)
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
      this.setData({
        showNicknamePopup: true,
        nicknamePopupError: '请先填写昵称',
      })
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

  goMe() {
    wx.navigateTo({ url: '/pages/profile-setup/index?from=me' })
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
