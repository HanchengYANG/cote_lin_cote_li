const { call } = require('../../utils/api')
const { centToEuro } = require('../../utils/format')
const { outOfStockMessage } = require('../../utils/order-errors')
const { normalizePhone, isPhoneValid } = require('../../utils/phone')
const { getSnapshot, invalidateSnapshot } = require('../../utils/app-snapshot')
const { createPage } = require('../../utils/create-page')
const { showResultError } = require('../../utils/error-feedback')

const PAYMENT_METHODS = [
  { label: '现金', value: 'cash' },
  { label: '微信转账', value: 'wechat_transfer' },
  { label: '支付宝转账', value: 'alipay_transfer' },
]

function findPaymentMethodIndex(value) {
  const normalized = String(value || '').trim()
  const idx = PAYMENT_METHODS.findIndex((x) => x.value === normalized)
  return idx >= 0 ? idx : 0
}

function normalizeCartItems(input) {
  const arr = Array.isArray(input) ? input : []
  const out = []
  for (const it of arr) {
    const dishId = String((it && it.dishId) || '').trim()
    const qty = Number(it && it.qty)
    if (!dishId || !Number.isFinite(qty) || qty <= 0) continue
    out.push({
      dishId,
      qty: Math.floor(qty),
      name: String((it && it.name) || ''),
      priceCents: Number(it && it.priceCents) || 0,
    })
  }
  return out
}

function hasAddressId(addresses, id) {
  const arr = Array.isArray(addresses) ? addresses : []
  const target = String(id || '')
  return arr.some((x) => String((x && x.id) || '') === target)
}

function getFirstAddressId(addresses) {
  const arr = Array.isArray(addresses) ? addresses : []
  return String((arr[0] && arr[0].id) || '')
}

function recalcLinesAndApplyCheckoutView(page) {
  page.recalcLines()
  page.applyCheckoutViewModel()
}

function setDataAndApplyCheckoutView(page, patch) {
  page.setData(patch)
  page.applyCheckoutViewModel()
}

function resolveEffectiveFulfillmentType(data) {
  const lockedType = String((data && data.existingOrderFulfillmentType) || '').trim()
  return data && data.hasExistingOrder && lockedType ? lockedType : (data && data.fulfillmentType)
}

function resolveEffectiveAddressId(data, effectiveType) {
  const lockedAddressId = String((data && data.existingOrderAddressId) || '').trim()
  if (effectiveType !== 'delivery') return ''
  return data && data.hasExistingOrder && lockedAddressId ? lockedAddressId : (data && data.selectedAddressId)
}

function buildCreateOrderPayload(data) {
  const paymentMethod = PAYMENT_METHODS[data.paymentMethodIndex].value
  const effectiveType = resolveEffectiveFulfillmentType(data)
  const effectiveAddressId = resolveEffectiveAddressId(data, effectiveType)
  return {
    saleId: data.sale && data.sale._id,
    fulfillmentType: effectiveType,
    addressId: effectiveAddressId,
    phone: effectiveType === 'pickup' ? normalizePhone(data.pickupPhone) : '',
    acceptDeliverySlot: effectiveType === 'delivery' ? !!data.acceptDeliverySlot : false,
    items: (data.cartItems || []).map((it) => ({ dishId: it.dishId, qty: Number(it.qty || 0) })),
    payment: { method: paymentMethod },
    remark: String(data.remark || '').trim(),
  }
}

function decorateCheckoutAddress(a) {
  if (!a) return null
  const title = String(a.label || '').trim() || `${String(a.line1 || '').trim()} ${String(a.city || '').trim()}`.trim()
  const detail = [a.line1, a.line2, a.postalCode, a.city, a.country].filter(Boolean).join(', ')
  return { ...a, title, detail }
}

function buildDecoratedCheckoutAddresses(rawAddresses) {
  const arr = Array.isArray(rawAddresses) ? rawAddresses : []
  return arr.map((a) => decorateCheckoutAddress(a)).filter(Boolean)
}

function buildDishesByIdMap(input) {
  const dishes = Array.isArray(input) ? input : []
  const dishesById = {}
  for (const d of dishes) {
    if (d && d._id) dishesById[d._id] = d
  }
  return dishesById
}

function resolveSelectedAddressIdWhenSaleUnavailable(options = {}) {
  const addresses = options.addresses
  let selectedAddressId = String(options.currentSelectedAddressId || '').trim()
  const lockedAddressId =
    options.hasExistingOrder && String(options.fulfillmentType || '') === 'delivery'
      ? String(options.existingOrderAddressId || '').trim()
      : ''
  const preferredAddressId = String(options.preferredAddressId || '').trim()

  if (lockedAddressId && hasAddressId(addresses, lockedAddressId)) {
    selectedAddressId = lockedAddressId
  } else if (preferredAddressId && hasAddressId(addresses, preferredAddressId)) {
    selectedAddressId = preferredAddressId
  }
  if (!hasAddressId(addresses, selectedAddressId)) selectedAddressId = String(options.profileDefaultAddressId || '')
  if (!hasAddressId(addresses, selectedAddressId)) selectedAddressId = getFirstAddressId(addresses)
  return selectedAddressId
}

function resolveSelectedAddressIdWhenSaleOpen(options = {}) {
  const addresses = options.addresses
  let selectedAddressId = String(options.currentSelectedAddressId || '').trim()
  const preferredAddressId = String(options.preferredAddressId || '').trim()
  const existingOrderAddressId = String(options.existingOrderAddressId || '')

  if (!hasAddressId(addresses, selectedAddressId)) selectedAddressId = ''
  if (existingOrderAddressId) {
    selectedAddressId = existingOrderAddressId
  } else if (preferredAddressId && hasAddressId(addresses, preferredAddressId)) {
    selectedAddressId = preferredAddressId
  }
  if (!selectedAddressId) selectedAddressId = String(options.profileDefaultAddressId || '')
  if (!hasAddressId(addresses, selectedAddressId)) selectedAddressId = getFirstAddressId(addresses)
  return selectedAddressId
}

function resolveReloadSaleState(options = {}) {
  const currentData = options.currentData || {}
  const skipSaleFetch = !!options.skipSaleFetch
  const saleRes = options.saleRes || null

  let saleStatus = String(currentData.saleStatus || 'closed')
  let sale = currentData.sale || null
  let dishesById = currentData.dishesById || {}
  let cartItems = normalizeCartItems(currentData.cartItems)
  let removedCount = 0

  if (!skipSaleFetch) {
    if (saleRes && saleRes.ok) {
      if (!saleRes.data || !saleRes.data.sale) {
        saleStatus = 'closed'
        sale = null
        dishesById = {}
      } else {
        saleStatus = 'open'
        sale = saleRes.data.sale
        const dishes = Array.isArray(saleRes.data.dishes) ? saleRes.data.dishes : []
        const allowedSet = new Set((sale.dishIds || []).filter(Boolean))
        dishesById = buildDishesByIdMap(dishes)
        const prevItems = normalizeCartItems(currentData.cartItems)
        cartItems = prevItems.filter((it) => allowedSet.has(it.dishId))
        removedCount = prevItems.length - cartItems.length
      }
    } else {
      // 拉取失败时沿用当前页状态，避免 UI 闪成“未开单”。
      saleStatus = String(currentData.saleStatus || 'closed')
      sale = currentData.sale || null
      dishesById = currentData.dishesById || {}
      cartItems = normalizeCartItems(currentData.cartItems)
    }
  }

  return {
    saleStatus,
    sale,
    dishesById,
    cartItems,
    removedCount,
  }
}

function buildReloadPatchWhenSaleUnavailable(options = {}) {
  const currentData = options.currentData || {}
  const profile = options.profile || {}
  const addresses = options.addresses
  const selectedAddressId = resolveSelectedAddressIdWhenSaleUnavailable({
    addresses,
    currentSelectedAddressId: currentData.selectedAddressId,
    hasExistingOrder: currentData.hasExistingOrder,
    fulfillmentType: currentData.fulfillmentType,
    existingOrderAddressId: currentData.existingOrderAddressId,
    preferredAddressId: options.preferredAddressId,
    profileDefaultAddressId: profile.defaultAddressId,
  })
  const pickupPhone = normalizePhone(currentData.pickupPhone || '') || normalizePhone(profile && profile.profilePhone)
  return {
    saleStatus: options.saleStatus,
    sale: options.sale,
    hasExistingOrder: false,
    existingOrderLocked: false,
    existingOrderAmountCents: 0,
    existingOrderFulfillmentType: '',
    existingOrderAddressId: '',
    dishesById: options.dishesById || {},
    cartItems: options.cartItems || [],
    profile,
    addresses,
    selectedAddressId,
    pickupPhone,
  }
}

function buildReloadPatchWhenSaleOpen(options = {}) {
  const currentData = options.currentData || {}
  const profile = options.profile || {}
  const addresses = options.addresses
  const existingOrder = options.existingOrder || null
  const selectedAddressId = resolveSelectedAddressIdWhenSaleOpen({
    addresses,
    currentSelectedAddressId: currentData.selectedAddressId,
    existingOrderAddressId: existingOrder && existingOrder.addressId,
    preferredAddressId: options.preferredAddressId,
    profileDefaultAddressId: profile.defaultAddressId,
  })

  const next = {
    saleStatus: 'open',
    sale: options.sale,
    dishesById: options.dishesById || {},
    cartItems: options.cartItems || [],
    hasExistingOrder: !!existingOrder,
    existingOrderLocked: !!(existingOrder && existingOrder.customerLocked),
    existingOrderAmountCents: Number((existingOrder && existingOrder.totals && existingOrder.totals.amountCents) || 0),
    existingOrderFulfillmentType: String((existingOrder && existingOrder.fulfillmentType) || ''),
    existingOrderAddressId: String((existingOrder && existingOrder.addressId) || ''),
    profile,
    addresses,
    selectedAddressId,
  }

  const selectedAddr = (Array.isArray(addresses) ? addresses : []).find((x) => x.id === selectedAddressId) || null
  let pickupPhone = normalizePhone(currentData.pickupPhone || '') || normalizePhone(profile && profile.profilePhone)
  if (!pickupPhone && selectedAddr && selectedAddr.phone) pickupPhone = normalizePhone(selectedAddr.phone)

  if (existingOrder) {
    const method = String((existingOrder.payment && existingOrder.payment.method) || 'cash')
    const methodIdx = findPaymentMethodIndex(method)
    next.fulfillmentType = existingOrder.fulfillmentType || 'delivery'
    next.acceptDeliverySlot = existingOrder.fulfillmentType === 'delivery'
    next.paymentMethodIndex = methodIdx
    next.paymentMethodLabel = PAYMENT_METHODS[methodIdx].label
    next.remark = String(existingOrder.remark || '')
    if (next.fulfillmentType === 'pickup') {
      pickupPhone = normalizePhone(existingOrder && existingOrder.contact && existingOrder.contact.phone)
    }
  } else if ((addresses || []).length === 0) {
    next.fulfillmentType = 'pickup'
    next.acceptDeliverySlot = false
  }

  next.pickupPhone = pickupPhone
  return next
}

function buildSelectedAddressView(data) {
  const arr = Array.isArray(data && data.addresses) ? data.addresses : []
  const currentId = String((data && data.selectedAddressId) || '').trim()
  const idx = arr.findIndex((x) => String((x && x.id) || '').trim() === currentId)
  const picked = idx >= 0 ? arr[idx] : null
  const phoneText = picked ? normalizePhone(picked.phone || '') : ''
  return {
    selectedAddressIndex: idx >= 0 ? idx : 0,
    selectedAddressTitle: picked ? String(picked.title || '') : '',
    selectedAddressDetail: picked ? String(picked.detail || '') : '',
    selectedAddressPhoneText: phoneText,
    selectedAddress: picked || null,
  }
}

function buildSubmitState(data, selectedAddr) {
  let disabled = false
  let reason = ''
  if (data && data.submitting) {
    disabled = true
    reason = '提交中...'
  }
  if (!disabled && (!data || !Array.isArray(data.cartItems) || data.cartItems.length === 0)) {
    disabled = true
    reason = '当前购物车无可下单菜品'
  }
  if (!disabled && String((data && data.saleStatus) || '') !== 'open') {
    disabled = true
    reason = '当前未开单，暂不可提交订单'
  }
  if (!disabled && !!(data && data.existingOrderLocked)) {
    disabled = true
    reason = '该订单已由店主确认锁定，无法再修改'
  }
  const mergedTotalCents = Number((data && data.totalAmountCents) || 0) + Number((data && data.existingOrderAmountCents) || 0)
  if (!disabled && String((data && data.fulfillmentType) || '') === 'delivery') {
    if (!selectedAddr) {
      disabled = true
      reason = '请选择地址'
    } else if (Number(selectedAddr.minOrderCents || 0) > 0 && mergedTotalCents < Number(selectedAddr.minOrderCents || 0)) {
      disabled = true
      reason = `未达到起送价 €${centToEuro(selectedAddr.minOrderCents || 0)}`
    } else if (!(data && data.acceptDeliverySlot)) {
      disabled = true
      reason = '请勾选“我接受该时间段”'
    }
  }
  if (!disabled && String((data && data.fulfillmentType) || '') === 'pickup' && !isPhoneValid(data && data.pickupPhone)) {
    disabled = true
    reason = '自取请填写有效电话'
  }
  return { submitDisabled: disabled, submitDisabledReason: reason }
}

function buildAddressRuleView(data, selectedAddr) {
  if (String((data && data.fulfillmentType) || '') !== 'delivery' || !selectedAddr) {
    return { minOrderText: '', minOrderHint: '', pendingReviewHint: false }
  }
  const minOrderCents = Number((selectedAddr && selectedAddr.minOrderCents) || 0)
  if (minOrderCents > 0) {
    return {
      minOrderText: `该地址起送价：€${centToEuro(minOrderCents)}`,
      minOrderHint: '',
      pendingReviewHint: false,
    }
  }
  return {
    minOrderText: '',
    minOrderHint: '该城市暂无起送价规则，提交后会变为“待店主确认”，且不会立即扣库存。',
    pendingReviewHint: true,
  }
}

function buildCheckoutViewModel(data) {
  const selected = buildSelectedAddressView(data)
  const idx = Number((data && data.paymentMethodIndex) || 0)
  const safeIdx = idx >= 0 && idx < PAYMENT_METHODS.length ? idx : 0
  const isDelivery = String((data && data.fulfillmentType) || '') === 'delivery'
  const showDeliveryConfirmCard = !!(
    isDelivery && (selected.selectedAddressDetail || selected.selectedAddressPhoneText || selected.selectedAddressTitle)
  )
  return {
    selectedAddressIndex: selected.selectedAddressIndex,
    selectedAddressTitle: selected.selectedAddressTitle,
    selectedAddressDetail: selected.selectedAddressDetail,
    selectedAddressPhoneText: selected.selectedAddressPhoneText,
    showDeliveryConfirmCard,
    paymentMethodLabel: PAYMENT_METHODS[safeIdx].label,
    ...buildAddressRuleView(data, selected.selectedAddress),
    ...buildSubmitState(data, selected.selectedAddress),
  }
}

createPage({
  data: {
    loadPhase: 'loading',
    refresherTriggered: false,
    saleStatus: 'closed',
    sale: null,
    cartItems: [],
    lines: [],
    totalAmountEuro: '0.00',
    totalAmountCents: 0,
    hasExistingOrder: false,
    existingOrderLocked: false,
    existingOrderAmountCents: 0,
    existingOrderFulfillmentType: '',
    existingOrderAddressId: '',
    dishesById: {},
    profile: null,
    addresses: [],
    selectedAddressId: '',
    selectedAddressIndex: 0,
    selectedAddressTitle: '',
    selectedAddressDetail: '',
    selectedAddressPhoneText: '',
    showDeliveryConfirmCard: false,

    fulfillmentType: 'delivery',
    acceptDeliverySlot: false,

    minOrderText: '',
    minOrderHint: '',
    pendingReviewHint: false,

    paymentMethodLabels: PAYMENT_METHODS,
    paymentMethodIndex: 0,
    paymentMethodLabel: PAYMENT_METHODS[0].label,

    remark: '',
    pickupPhone: '',
    submitting: false,
    submitDisabled: true,
    submitDisabledReason: '',
  },

  async onLoad() {
    const cart = wx.getStorageSync('checkout_cart')
    const cartItems = normalizeCartItems(cart && cart.items)
    if (cartItems.length === 0) {
      wx.showToast({ title: '购物车为空', icon: 'none' })
      wx.navigateBack()
      return
    }
    this.setData({ cartItems })
    const hydrated = this.hydrateFromSnapshot()
    if (!hydrated) {
      this.setData({ saleStatus: 'closed', sale: null, dishesById: {} })
    }
    await this.reload({ silent: true, skipSaleFetch: true })
  },

  onShow() {
    const fromAddressBook = !!this._fromAddressBook
    this._fromAddressBook = false
    this.hydrateFromSnapshot()
    const pickedAddressId = String(wx.getStorageSync('checkout_selected_address_id') || '').trim()
    if (fromAddressBook) {
      this.setData({ loadPhase: 'loading' })
      this.reload({ silent: false, skipSaleFetch: true, preferredAddressId: pickedAddressId })
      return
    }
    this.reload({ silent: true, skipSaleFetch: true, preferredAddressId: pickedAddressId })
  },

  hydrateFromSnapshot() {
    const snapshot = getSnapshot()
    if (!snapshot || !snapshot.sale) return false
    const snapSale = snapshot.sale
    const dishesById = buildDishesByIdMap(snapshot.dishes)
    const saleStatusRaw = String((snapSale && snapSale.status) || '').trim()
    const isOpen = saleStatusRaw === 'OPEN'
    const sale = isOpen
      ? {
          _id: String(snapSale.saleId || snapSale._id || ''),
          status: saleStatusRaw || 'OPEN',
          deliveryTimeSlotLabel: String(snapSale.deliveryTimeSlotLabel || ''),
        }
      : null
    this.setData({
      saleStatus: isOpen ? 'open' : 'closed',
      sale,
      dishesById,
    })
    recalcLinesAndApplyCheckoutView(this)
    return true
  },

  saveCart() {
    wx.setStorageSync('checkout_cart', {
      items: this.data.cartItems,
      updatedAt: Date.now(),
    })
  },

  applyCheckoutViewModel() {
    this.setData(buildCheckoutViewModel(this.data))
  },

  async reload(options = {}) {
    const silent = !!options.silent
    const skipSaleFetch = !!options.skipSaleFetch
    const preferredAddressId = String(options.preferredAddressId || '').trim()
    this._reloadSeq = Number(this._reloadSeq || 0) + 1
    const seq = this._reloadSeq
    const isStale = () => seq !== this._reloadSeq
    const finishLoadPhase = () => {
      if (isStale()) return
      if (this.data.loadPhase !== 'ready') {
        this.setData({ loadPhase: 'ready' })
      }
    }
    const finishReloadUi = () => {
      finishLoadPhase()
      if (!silent) this.setData({ refresherTriggered: false })
    }
    const clearPreferredAddressSelection = () => {
      if (preferredAddressId) wx.removeStorageSync('checkout_selected_address_id')
    }
    if (this.data.loadPhase !== 'ready') this.setData({ loadPhase: 'loading' })
    if (!silent) {
      this.setData({ refresherTriggered: true })
    }
    let saleRes = null
    if (!skipSaleFetch) {
      saleRes = await call('customer', 'getCurrentSale')
      if (isStale()) return
      if (saleRes && !saleRes.ok) {
        wx.showToast({ title: saleRes.message || '加载开单失败', icon: 'none' })
      }
    }
    const profileRes = await call('customer', 'getMyProfile')
    if (isStale()) return
    if (!profileRes || !profileRes.ok || !profileRes.data || !profileRes.data.profile) {
      finishReloadUi()
      wx.showToast({ title: '资料加载失败', icon: 'none' })
      return
    }

    const profile = profileRes.data.profile
    const addresses = buildDecoratedCheckoutAddresses(profile && profile.addresses)
    const saleState = resolveReloadSaleState({
      currentData: this.data,
      skipSaleFetch,
      saleRes,
    })
    const { saleStatus, sale, dishesById, cartItems, removedCount } = saleState
    if (removedCount > 0) {
      wx.showToast({ title: `已移除 ${removedCount} 个非本次开单菜品`, icon: 'none', __forceToast: true })
    }

    if (saleStatus !== 'open' || !sale || !sale._id) {
      const patch = buildReloadPatchWhenSaleUnavailable({
        currentData: this.data,
        saleStatus,
        sale,
        dishesById,
        cartItems,
        profile,
        addresses,
        preferredAddressId,
      })
      this.setData(patch)
      clearPreferredAddressSelection()
      this.applyCheckoutViewModel()
      recalcLinesAndApplyCheckoutView(this)
      finishReloadUi()
      return
    }

    let existingOrder = null
    const orderRes = await call('customer', 'getMySaleOrder', { saleId: sale._id })
    if (isStale()) return
    if (orderRes.ok && orderRes.data && orderRes.data.order) existingOrder = orderRes.data.order

    const patch = buildReloadPatchWhenSaleOpen({
      currentData: this.data,
      sale,
      dishesById,
      cartItems,
      profile,
      addresses,
      preferredAddressId,
      existingOrder,
    })
    this.setData(patch)
    clearPreferredAddressSelection()
    this.applyCheckoutViewModel()
    this.saveCart()
    recalcLinesAndApplyCheckoutView(this)
    finishReloadUi()
  },

  onPullDownRefresh() {
    this.reload().finally(() => {
      wx.stopPullDownRefresh()
    })
  },

  recalcLines() {
    const dishesById = this.data.dishesById || {}
    const lines = []
    let totalCents = 0
    for (const it of this.data.cartItems) {
      const dish = dishesById[it.dishId]
      const qty = Number(it.qty || 0)
      if (qty <= 0) continue
      const unitPriceCents = dish ? Number(dish.priceCents || 0) : Number(it.priceCents || 0)
      const lineTotalCents = unitPriceCents * qty
      totalCents += lineTotalCents
      lines.push({
        dishId: it.dishId,
        name: dish ? String(dish.name || it.name || '') : String(it.name || ''),
        qty,
        unitPriceEuro: centToEuro(unitPriceCents),
        lineTotalEuro: centToEuro(lineTotalCents),
      })
    }
    this.setData({
      lines,
      totalAmountEuro: centToEuro(totalCents),
      totalAmountCents: totalCents,
    })
  },

  onFulfillmentChange(e) {
    if (this.data.hasExistingOrder) {
      wx.showToast({ title: '已有订单不可修改交货方式', icon: 'none' })
      return
    }
    const v = e.detail.value
    setDataAndApplyCheckoutView(this, {
      fulfillmentType: v,
      acceptDeliverySlot: v === 'delivery' ? this.data.acceptDeliverySlot : false,
    })
  },

  onAcceptChange(e) {
    const arr = (e && e.detail && e.detail.value) || []
    const accept = Array.isArray(arr) ? arr.includes('accept') : false
    setDataAndApplyCheckoutView(this, { acceptDeliverySlot: accept })
  },

  onPaymentMethodPick(e) {
    const idx = Number(e.detail.value || 0)
    setDataAndApplyCheckoutView(this, { paymentMethodIndex: idx })
  },

  onRemarkInput(e) {
    this.setData({ remark: e.detail.value })
  },

  onPickupPhoneInput(e) {
    const v = normalizePhone(e && e.detail && e.detail.value)
    setDataAndApplyCheckoutView(this, { pickupPhone: v })
  },

  onAddressPick(e) {
    if (this.data.hasExistingOrder && this.data.fulfillmentType === 'delivery') {
      return
    }
    const idx = Number(e.detail.value || 0)
    const arr = this.data.addresses || []
    const picked = arr[idx]
    if (!picked) return
    setDataAndApplyCheckoutView(this, { selectedAddressId: picked.id })
  },

  goAddressBook() {
    if (this.data.hasExistingOrder && this.data.fulfillmentType === 'delivery') {
      return
    }
    this._fromAddressBook = true
    const selectedAddressId = String(this.data.selectedAddressId || '')
    wx.navigateTo({ url: `/pages/address-book/index?select=1&selectedAddressId=${encodeURIComponent(selectedAddressId)}` })
  },

  async handleSubmitError(res) {
    invalidateSnapshot()
    if (res.code === 'OUT_OF_STOCK') {
      wx.showToast({ title: outOfStockMessage(res.detail, '库存不足，请返回菜单调整'), icon: 'none' })
      await this.reload()
      return
    }
    if (res.code === 'MIN_ORDER_NOT_MET') {
      const d = res.detail || {}
      const msg = `未达到起送价：€${centToEuro(d.minOrderCents || 0)}`
      wx.showToast({ title: msg, icon: 'none' })
      return
    }
    if (res.code === 'FULFILLMENT_LOCKED' || res.code === 'ADDRESS_LOCKED') {
      wx.showToast({ title: res.message || '已有订单不可修改交货方式或地址', icon: 'none' })
      await this.reload()
      return
    }
    if (res.code === 'ORDER_LOCKED_FOR_CUSTOMER') {
      wx.showToast({ title: res.message || '该订单已锁定，无法修改', icon: 'none' })
      await this.reload()
      return
    }
    if (res.code === 'INVALID_PHONE') {
      wx.showToast({ title: '请填写有效电话', icon: 'none' })
      return
    }
    if (res.code === 'PROFILE_INCOMPLETE') {
      await showResultError(res, '请先完善资料')
      wx.navigateTo({ url: '/pages/profile-setup/index?from=checkout' })
      return
    }
    await showResultError(res, '下单失败')
  },

  async submit() {
    if (this.data.submitDisabled || this.data.submitting) return
    setDataAndApplyCheckoutView(this, { submitting: true })
    const payload = buildCreateOrderPayload(this.data)
    const res = await call('customer', 'createOrder', payload)
    setDataAndApplyCheckoutView(this, { submitting: false })
    if (!res.ok) {
      await this.handleSubmitError(res)
      return
    }
    invalidateSnapshot()
    wx.removeStorageSync('checkout_cart')
    const orderId = res.data && res.data.orderId
    wx.redirectTo({ url: `/pages/order-success/index?orderId=${encodeURIComponent(orderId)}` })
  },
})
