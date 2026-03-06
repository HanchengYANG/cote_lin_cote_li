const { centToEuro } = require('../../utils/format')
const { call } = require('../../utils/api')
const { getSession } = require('../../utils/session')
const { invalidateSnapshot } = require('../../utils/app-snapshot')
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

function buildProfileSummary(rawProfile) {
  return {
    isComplete: !!(rawProfile && rawProfile.isComplete),
    nickname: String((rawProfile && rawProfile.nickname) || ''),
    addressCount: Number((rawProfile && rawProfile.addressCount) || 0),
    defaultAddressId: String((rawProfile && rawProfile.defaultAddressId) || ''),
  }
}

function buildSaleInfo(rawSale) {
  return {
    saleId: String((rawSale && rawSale.saleId) || ''),
    status: String((rawSale && rawSale.status) || ''),
    deliveryTimeSlotLabel: String((rawSale && rawSale.deliveryTimeSlotLabel) || ''),
    note: String((rawSale && rawSale.note) || '').trim(),
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

function buildNoticeViewState(note) {
  const noticePreview = buildNoticePreview(note)
  return {
    noticePreviewText: noticePreview.text,
    noticeCanToggle: noticePreview.canToggle,
    noticeLines: buildNoticeLines(note),
  }
}

function buildApplySnapshotPatch(profileSummary, currentData) {
  const patch = {
    showNicknamePopup: !profileSummary.isComplete,
  }
  if (profileSummary.isComplete) {
    patch.nicknameSaving = false
    patch.nicknamePopupError = ''
  } else if (!String((currentData && currentData.nicknameDraft) || '').trim()) {
    patch.nicknameDraft = profileSummary.nickname
  }
  return patch
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

function decorateHomeDish(d, saleInfo, prevQtyMap) {
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
}

function buildQtyMapFromDishes(dishes) {
  const qtyMap = {}
  for (const d of dishes || []) qtyMap[d._id] = Number(d.qty || 0)
  return qtyMap
}

function buildDishSelectionState(dishes) {
  const qtyMap = buildQtyMapFromDishes(dishes)
  const { totalQty, totalAmountCents } = calcTotals(dishes || [], qtyMap)
  return {
    qtyMap,
    totalQty,
    totalAmountEuro: centToEuro(totalAmountCents),
  }
}

function applyDishSelectionState(page, dishes) {
  page.setData({
    dishes,
    ...buildDishSelectionState(dishes),
  })
}

function buildCheckoutCartItemsFromDishes(dishes) {
  const items = []
  for (const d of Array.isArray(dishes) ? dishes : []) {
    const qty = Number(d && d.qty)
    if (qty <= 0) continue
    items.push({
      dishId: d._id,
      qty,
      name: d.name,
      priceCents: Number(d.priceCents || 0),
    })
  }
  return items
}

function formatStampedErrorMessage(message) {
  const msg = String(message || '未知错误')
  const now = new Date()
  const hh = `${now.getHours()}`.padStart(2, '0')
  const mm = `${now.getMinutes()}`.padStart(2, '0')
  const ss = `${now.getSeconds()}`.padStart(2, '0')
  return {
    message: msg,
    stamped: `[${hh}:${mm}:${ss}] ${msg}`,
  }
}

function setHomeRefresherTriggered(page, silent, triggered) {
  if (silent) return
  page.setData({ refresherTriggered: !!triggered })
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
    if (!this._hasLoadedOnce || this.__hasRestoredSnapshot) return
    this.reload({ silent: true, allowRedirect: true })
  },

  async bootstrap() {
    if (!wx.cloud) {
      this.reportError('请先启用云开发')
      return
    }
    if (this.__hasRestoredSnapshot) return
    await this.reload({ silent: true, allowRedirect: true })
  },

  applySnapshot(snapshot, options = {}) {
    const rawProfile = snapshot.profile || null
    const profileSummary = buildProfileSummary(rawProfile)
    this.applyBootstrap(snapshot.sale, snapshot.dishes, rawProfile, snapshot.session || null, snapshot.myCurrentSaleOrder || null)
    const patch = buildApplySnapshotPatch(profileSummary, this.data)
    this.setData(patch)
    return true
  },

  applyBootstrap(rawSale, rawDishes, rawProfile, rawSession, rawMyCurrentSaleOrder) {
    const prevQtyMap = { ...(this.data.qtyMap || {}) }
    const saleInfo = buildSaleInfo(rawSale)
    const dishes = normalizeDishes(rawDishes).map((d) => decorateHomeDish(d, saleInfo, prevQtyMap))
    const sorted = sortDishesBySaleState(dishes, saleInfo)
    const dishSelectionState = buildDishSelectionState(sorted)
    const profileSummary = buildProfileSummary(rawProfile)
    const myCurrentSaleOrder = normalizeMyCurrentSaleOrder(rawMyCurrentSaleOrder)
    const customerOrderProgressText = buildCustomerOrderProgressText(saleInfo, myCurrentSaleOrder)
    const shouldShowDeliverySlot = shouldShowDeliverySlotForCurrentCustomer(saleInfo, myCurrentSaleOrder)
    const noticeViewState = buildNoticeViewState(saleInfo.note)
    this.setData({
      saleInfo,
      profileSummary,
      myCurrentSaleOrder,
      customerOrderProgressText,
      shouldShowDeliverySlot,
      dishes: sorted,
      ...dishSelectionState,
      ...noticeViewState,
      isAdmin: !!(rawSession && rawSession.isAdmin),
      isHydrating: false,
      lastErrorMsg: '',
    })
  },

  reportError(message, detail) {
    const built = formatStampedErrorMessage(message)
    const msg = built.message
    const stamped = built.stamped
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
    setHomeRefresherTriggered(this, silent, true)
    invalidateSnapshot()
    const [homeRes, sess] = await Promise.all([call('customer', 'bootstrapHome'), getSession()])
    setHomeRefresherTriggered(this, silent, false)
    if (!homeRes || !homeRes.ok || !homeRes.data) {
      this.setData({ isHydrating: false })
      this.reportError((homeRes && homeRes.message) || '加载菜单失败')
      return
    }
    if (!sess || !sess.ready) {
      this.setData({ isHydrating: false })
      this.reportError('加载菜单失败')
      return
    }
    this.applySnapshot(
      {
        sale: homeRes.data.sale,
        dishes: homeRes.data.dishes,
        profile: homeRes.data.profile,
        myCurrentSaleOrder: homeRes.data.myCurrentSaleOrder,
        session: {
          openId: String(sess.openId || '').trim(),
          isAdmin: !!sess.isAdmin,
        },
      },
      { allowRedirect }
    )
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
    applyDishSelectionState(this, dishes)
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
    const items = buildCheckoutCartItemsFromDishes(this.data.dishes)
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



