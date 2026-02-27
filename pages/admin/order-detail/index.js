const { call } = require('../../../utils/api')
const { invalidateSnapshot } = require('../../../utils/app-snapshot')
const { showErrorDialog } = require('../../../utils/error-feedback')
const {
  normalizePhone,
  normalizePhoneInputDigits,
  isPhoneValid,
  formatPhoneDisplay,
  formatPhoneBlurValue,
} = require('../../../utils/phone')
const { normalizeFrAddress, isFrAddressValid } = require('../../../utils/fr-address')
const { parseSlotLabel, buildSlotLabel } = require('../../../utils/delivery-slot')
const { suggestAddressDirect, line1FromSuggestion } = require('../../../utils/address-suggest')
const { exportAndOpenOrderLabelsPdf } = require('../../../utils/order-label-export')
const { createPage } = require('../../../utils/create-page')
const {
  decorateOrder,
  buildEditableItems,
  calcEditableTotals,
  applyQtyDelta,
  removeDish,
  buildPayloadItems,
} = require('../../../utils/order-editor')

const PAYMENT_METHOD_OPTIONS = [
  { label: '现金', value: 'cash' },
  { label: '微信转账', value: 'wechat_transfer' },
  { label: '支付宝转账', value: 'alipay_transfer' },
]
const PAID_STATUS_OPTIONS = [
  { label: '未收款', value: 'UNPAID' },
  { label: '已收款', value: 'PAID' },
]
const HANDOFF_STATUS_OPTIONS = [
  { label: '未送达', value: 'PENDING' },
  { label: '已送达', value: 'DELIVERED' },
]

function normalizePaymentMethodValue(input) {
  const v = String(input || '').trim()
  if (v === 'cash') return 'cash'
  if (v === 'wechat_transfer') return 'wechat_transfer'
  if (v === 'alipay_transfer') return 'alipay_transfer'
  return 'cash'
}

function paymentMethodLabel(input) {
  const v = normalizePaymentMethodValue(input)
  if (v === 'wechat_transfer') return '微信转账'
  if (v === 'alipay_transfer') return '支付宝转账'
  return '现金'
}

function normalizePaidStatusValue(input) {
  return String(input || '').trim() === 'PAID' ? 'PAID' : 'UNPAID'
}

function normalizeHandoffStatusValue(input) {
  return String(input || '').trim() === 'DELIVERED' ? 'DELIVERED' : 'PENDING'
}

function buildItemsPayloadForCompare(items) {
  return (Array.isArray(items) ? items : [])
    .map((it) => ({
      dishId: String((it && it.dishId) || '').trim(),
      qty: Math.max(0, Number((it && it.qty) || 0)),
    }))
    .filter((it) => it.dishId)
    .sort((a, b) => (a.dishId < b.dishId ? -1 : a.dishId > b.dishId ? 1 : 0))
}

function sameItemsPayload(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) {
    if (a[i].dishId !== b[i].dishId || Number(a[i].qty || 0) !== Number(b[i].qty || 0)) return false
  }
  return true
}

function getSafePickerIndex(rawValue, options) {
  const idx = Number(rawValue || 0)
  const len = Array.isArray(options) ? options.length : 0
  if (len <= 0) return 0
  return Number.isFinite(idx) && idx >= 0 && idx < len ? idx : 0
}

function setEditableItemsState(page, editableItems) {
  page.setData({
    editableItems,
    editableTotals: calcEditableTotals(editableItems),
  })
}

function toDishPickerOption(d) {
  return {
    _id: String((d && d._id) || ''),
    name: String((d && d.name) || '').trim(),
    priceCents: Number((d && d.priceCents) || 0),
    priceEuro: ((Number((d && d.priceCents) || 0) || 0) / 100).toFixed(2),
    isActive: !!(d && d.isActive),
  }
}

function normalizeManualAddress(input) {
  const normalized = normalizeFrAddress(input) || {}
  return {
    label: String(normalized.label || '').trim(),
    line1: String(normalized.line1 || '').trim(),
    line2: String(normalized.line2 || '').trim(),
    postalCode: String(normalized.postalCode || '').trim(),
    city: String(normalized.city || '').trim(),
    country: String(normalized.country || 'FR').trim().toUpperCase() || 'FR',
  }
}

function isManualAddressValid(addr) {
  return isFrAddressValid(normalizeManualAddress(addr), { requirePhone: false, requireLabel: false })
}

function navigateBackAfterSuccess(title) {
  wx.showToast({ title: title || '已保存', icon: 'success' })
  setTimeout(() => {
    wx.navigateBack()
  }, 180)
}

createPage({
  data: {
    orderId: '',
    order: null,
    canEditItems: false,
    canCancelOrder: false,
    isPendingReview: false,
    editableItems: [],
    editableTotals: { qty: 0, amountEuro: '0.00' },
    fulfillmentTypeDraft: 'delivery',
    customerAddresses: [],
    addressMode: 'saved',
    selectedAddressId: '',
    selectedAddressIndex: 0,
    phoneDraft: '',
    manualAddress: {
      label: '',
      line1: '',
      line2: '',
      postalCode: '',
      city: '',
      country: 'FR',
    },
    manualAddressSuggestions: [],
    manualAddressLine1Focused: false,
    deliverySlotInput: '',
    slotDate: '',
    slotStart: '',
    slotEnd: '',
    approving: false,
    saving: false,
    cancelling: false,
    canEditPaymentMethod: false,
    canEditProgressStatus: false,
    paymentMethodOptions: PAYMENT_METHOD_OPTIONS,
    paymentMethodIndex: 0,
    paymentMethodLabel: PAYMENT_METHOD_OPTIONS[0].label,
    paidStatusOptions: PAID_STATUS_OPTIONS,
    paidStatusIndex: 0,
    paidStatusDraft: 'UNPAID',
    handoffStatusOptions: HANDOFF_STATUS_OPTIONS,
    handoffStatusIndex: 0,
    handoffStatusDraft: 'PENDING',
    remarkDraft: '',
    showDishPicker: false,
    loadingDishPicker: false,
    allDishesForPick: [],
    exportingLabelPdf: false,
  },

  onLoad(query) {
    this._manualAddrSuggestReqId = 0
    this._manualAddrSuggestTimer = null
    this._isPickingManualAddrSuggestion = false
    this._ignoreNextManualAddrLine1Input = null
    const orderId = (query && query.orderId) || ''
    this.setData({ orderId })
    this.reload()
  },

  onUnload() {
    if (this._manualAddrSuggestTimer) clearTimeout(this._manualAddrSuggestTimer)
    this._manualAddrSuggestTimer = null
    this._isPickingManualAddrSuggestion = false
    this._ignoreNextManualAddrLine1Input = null
  },

  async reload() {
    const res = await call('admin', 'getOrderDetail', { orderId: this.data.orderId })
    if (!res.ok) {
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }
    const rawOrder = res.data && res.data.order
    const customerAddresses = Array.isArray(res.data && res.data.customerAddresses) ? res.data.customerAddresses : []
    const order = rawOrder ? decorateOrder(rawOrder) : null
    const canEditItems = !!(rawOrder && (rawOrder.status === 'ACTIVE' || rawOrder.status === 'PENDING_REVIEW'))
    const isPendingReview = !!(rawOrder && rawOrder.status === 'PENDING_REVIEW')
    const editableItems = buildEditableItems(rawOrder)
    const rawSlotLabel = String((rawOrder && rawOrder.deliveryTimeSlotLabelSnapshot) || '')
    const parsed = parseSlotLabel(rawSlotLabel)
    const orderAddressId = String((rawOrder && rawOrder.addressId) || '').trim()
    const matchedSavedAddress = customerAddresses.find((x) => String(x.id || '').trim() === orderAddressId) || null
    const manualAddress = normalizeManualAddress((rawOrder && rawOrder.address) || null)
    const addressMode = matchedSavedAddress || customerAddresses.length > 0 ? 'saved' : 'manual'
    const selectedAddressId = matchedSavedAddress ? matchedSavedAddress.id : String((customerAddresses[0] && customerAddresses[0].id) || '')
    const selectedAddressIndex = Math.max(
      0,
      customerAddresses.findIndex((x) => String(x.id || '').trim() === selectedAddressId)
    )
    let phoneDraft = normalizePhone(rawOrder && rawOrder.contact && rawOrder.contact.phone)
    if (!phoneDraft && matchedSavedAddress && matchedSavedAddress.phone) phoneDraft = normalizePhone(matchedSavedAddress.phone)
    phoneDraft = formatPhoneDisplay(phoneDraft) || phoneDraft
    const normalizedMethod = normalizePaymentMethodValue(rawOrder && rawOrder.payment && rawOrder.payment.method)
    const paymentMethodIndex = PAYMENT_METHOD_OPTIONS.findIndex((it) => it.value === normalizedMethod)
    const normalizedPaidStatus = normalizePaidStatusValue(rawOrder && rawOrder.payment && rawOrder.payment.paidStatus)
    const paidStatusIndex = PAID_STATUS_OPTIONS.findIndex((it) => it.value === normalizedPaidStatus)
    const normalizedHandoffStatus = normalizeHandoffStatusValue(rawOrder && rawOrder.handoffStatus)
    const handoffStatusIndex = HANDOFF_STATUS_OPTIONS.findIndex((it) => it.value === normalizedHandoffStatus)
    const rawStatus = String((rawOrder && rawOrder.status) || '').trim()
    const remarkDraft = String((rawOrder && rawOrder.remark) || '')
    this._ignoreNextManualAddrLine1Input = null
    this.setData({
      order,
      canEditItems,
      canCancelOrder: canEditItems,
      isPendingReview,
      canEditPaymentMethod: rawStatus === 'ACTIVE' || rawStatus === 'PENDING_REVIEW',
      canEditProgressStatus: rawStatus === 'ACTIVE',
      editableItems,
      editableTotals: calcEditableTotals(editableItems),
      fulfillmentTypeDraft: String((rawOrder && rawOrder.fulfillmentType) || 'delivery'),
      customerAddresses,
      addressMode,
      selectedAddressId,
      selectedAddressIndex,
      phoneDraft,
      manualAddress,
      deliverySlotInput: rawSlotLabel,
      slotDate: parsed ? parsed.slotDate : '',
      slotStart: parsed ? parsed.slotStart : '',
      slotEnd: parsed ? parsed.slotEnd : '',
      paymentMethodIndex: paymentMethodIndex >= 0 ? paymentMethodIndex : 0,
      paymentMethodLabel: paymentMethodLabel(normalizedMethod),
      paidStatusIndex: paidStatusIndex >= 0 ? paidStatusIndex : 0,
      paidStatusDraft: normalizedPaidStatus,
      handoffStatusIndex: handoffStatusIndex >= 0 ? handoffStatusIndex : 0,
      handoffStatusDraft: normalizedHandoffStatus,
      remarkDraft,
    })
  },

  noop() {},

  onPickPaymentMethod(e) {
    const safeIdx = getSafePickerIndex(e && e.detail && e.detail.value, PAYMENT_METHOD_OPTIONS)
    const picked = PAYMENT_METHOD_OPTIONS[safeIdx]
    this.setData({
      paymentMethodIndex: safeIdx,
      paymentMethodLabel: picked.label,
    })
  },

  onPickPaidStatus(e) {
    const safeIdx = getSafePickerIndex(e && e.detail && e.detail.value, PAID_STATUS_OPTIONS)
    const picked = PAID_STATUS_OPTIONS[safeIdx]
    this.setData({
      paidStatusIndex: safeIdx,
      paidStatusDraft: picked.value,
    })
  },

  onPickHandoffStatus(e) {
    const safeIdx = getSafePickerIndex(e && e.detail && e.detail.value, HANDOFF_STATUS_OPTIONS)
    const picked = HANDOFF_STATUS_OPTIONS[safeIdx]
    this.setData({
      handoffStatusIndex: safeIdx,
      handoffStatusDraft: picked.value,
    })
  },

  async onOpenAddDishPicker() {
    if (!this.data.canEditItems || this.data.loadingDishPicker) return
    if (!(this.data.allDishesForPick || []).length) {
      this.setData({ loadingDishPicker: true })
      const res = await call('admin', 'listDishes')
      this.setData({ loadingDishPicker: false })
      if (!res.ok) {
        wx.showToast({ title: res.message || '加载菜品失败', icon: 'none' })
        return
      }
      const allDishesForPick = Array.isArray(res.data && res.data.dishes)
        ? res.data.dishes.map((d) => toDishPickerOption(d))
        : []
      this.setData({ allDishesForPick })
    }
    this.setData({ showDishPicker: true })
  },

  onCloseDishPicker() {
    this.setData({ showDishPicker: false })
  },

  onPickDishToAdd(e) {
    if (!this.data.canEditItems) return
    const dishId = String((e.currentTarget.dataset && e.currentTarget.dataset.id) || '').trim()
    if (!dishId) return
    const picked = (this.data.allDishesForPick || []).find((d) => String(d._id || '').trim() === dishId)
    if (!picked) return
    const existingIdx = (this.data.editableItems || []).findIndex((it) => String(it.dishId || '').trim() === dishId)
    let editableItems = []
    if (existingIdx >= 0) {
      editableItems = (this.data.editableItems || []).map((it, idx) => {
        if (idx !== existingIdx) return it
        const nextQty = Math.max(0, Number(it.qty || 0) + 1)
        return {
          ...it,
          qty: nextQty,
          lineTotalEuro: ((Number(it.unitPriceCents || 0) * nextQty) / 100).toFixed(2),
        }
      })
    } else {
      editableItems = (this.data.editableItems || []).concat({
        dishId,
        dishName: picked.name || '未命名菜品',
        unitPriceCents: Number(picked.priceCents || 0),
        unitPriceEuro: picked.priceEuro,
        qty: 1,
        lineTotalEuro: picked.priceEuro,
      })
    }
    this.setData({ showDishPicker: false })
    setEditableItemsState(this, editableItems)
  },

  async savePaymentAndProgressDraft() {
    const order = this.data.order
    if (!order || !this.data.orderId) return { ok: true, changed: false }
    const orderStatus = String((order && order.status) || '').trim()
    const option = PAYMENT_METHOD_OPTIONS[this.data.paymentMethodIndex] || PAYMENT_METHOD_OPTIONS[0]
    const nextMethod = option.value
    const currentMethod = normalizePaymentMethodValue(order && order.payment && order.payment.method)
    const nextPaidStatus = normalizePaidStatusValue(this.data.paidStatusDraft)
    const nextHandoffStatus = normalizeHandoffStatusValue(this.data.handoffStatusDraft)
    const currentPaidStatus = normalizePaidStatusValue(order && order.payment && order.payment.paidStatus)
    const currentHandoffStatus = normalizeHandoffStatusValue(order && order.handoffStatus)

    if (orderStatus === 'ACTIVE') {
      const payload = { orderId: this.data.orderId }
      if (nextMethod !== currentMethod) payload.paymentMethod = nextMethod
      if (nextPaidStatus !== currentPaidStatus) payload.paidStatus = nextPaidStatus
      if (nextHandoffStatus !== currentHandoffStatus) payload.handoffStatus = nextHandoffStatus
      if (Object.keys(payload).length === 1) return { ok: true, changed: false }
      const res = await call('admin', 'updateOrderFulfillmentProgress', payload)
      if (!res.ok) {
        wx.showToast({ title: res.message || '保存付款/履约状态失败', icon: 'none' })
        await this.reload()
        return { ok: false, changed: false }
      }
      return { ok: true, changed: true }
    }

    if (orderStatus === 'PENDING_REVIEW') {
      if (nextMethod === currentMethod) return { ok: true, changed: false }
      const res = await call('admin', 'updateOrderPaymentMethod', {
        orderId: this.data.orderId,
        paymentMethod: nextMethod,
      })
      if (!res.ok) {
        wx.showToast({ title: res.message || '保存付款方式失败', icon: 'none' })
        await this.reload()
        return { ok: false, changed: false }
      }
      return { ok: true, changed: true }
    }

    return { ok: true, changed: false }
  },

  onQtyChange(e) {
    if (!this.data.canEditItems) return
    const dishId = String((e.detail && e.detail.dishId) || '').trim()
    const delta = Number(e.detail && e.detail.delta)
    if (!dishId || !Number.isFinite(delta)) return
    const editableItems = applyQtyDelta(this.data.editableItems, dishId, delta)
    setEditableItemsState(this, editableItems)
  },

  onRemoveItem(e) {
    if (!this.data.canEditItems) return
    const dishId = String((e.detail && e.detail.dishId) || '').trim()
    if (!dishId) return
    const editableItems = removeDish(this.data.editableItems, dishId)
    setEditableItemsState(this, editableItems)
  },

  async onSaveItems() {
    if (!this.data.canEditItems || this.data.saving) return
    this.setData({ saving: true })
    const payloadItems = buildPayloadItems(this.data.editableItems)
    const currentItemsPayload = buildItemsPayloadForCompare(this.data.order && this.data.order.items)
    const nextItemsPayload = buildItemsPayloadForCompare(payloadItems)
    const itemsChanged = !sameItemsPayload(currentItemsPayload, nextItemsPayload)
    const currentRemark = String((this.data.order && this.data.order.remark) || '').trim()
    const nextRemark = String(this.data.remarkDraft || '').trim()
    const remarkChanged = currentRemark !== nextRemark
    const hasAny = payloadItems.some((it) => it.qty > 0)
    if (itemsChanged && !hasAny) {
      this.setData({ saving: false })
      wx.showToast({ title: '订单不能清空，请点取消整单', icon: 'none' })
      return
    }

    const fulfillmentRes = await this.trySaveFulfillmentDraft()
    if (!fulfillmentRes.ok) {
      this.setData({ saving: false })
      return
    }

    const paymentRes = await this.savePaymentAndProgressDraft()
    if (!paymentRes.ok) {
      this.setData({ saving: false })
      return
    }

    if (!itemsChanged && !fulfillmentRes.changed && !paymentRes.changed && !remarkChanged) {
      this.setData({ saving: false })
      wx.showToast({ title: '无修改', icon: 'none' })
      return
    }

    let res = { ok: true }
    if (itemsChanged) {
      res = await call('admin', 'updateOrderItems', {
        orderId: this.data.orderId,
        items: payloadItems,
      })
    }
    if (!res.ok) {
      this.setData({ saving: false })
      wx.showToast({ title: res.message || '保存失败', icon: 'none' })
      await this.reload()
      return
    }
    const remarkRes = await this.saveRemarkDraft()
    if (!remarkRes.ok) {
      this.setData({ saving: false })
      return
    }
    this.setData({ saving: false })
    invalidateSnapshot()
    navigateBackAfterSuccess('已保存')
  },

  async onCancelOrder() {
    if (!this.data.canCancelOrder || this.data.cancelling) return
    const modalRes = await new Promise((resolve) => {
      wx.showModal({
        title: '确认取消订单',
        content: '取消后默认不计入统计导出。',
        confirmColor: '#d93025',
        success: resolve,
        fail: () => resolve({ confirm: false }),
      })
    })
    if (!modalRes.confirm) return
    this.setData({ cancelling: true })
    const res = await call('admin', 'cancelOrder', { orderId: this.data.orderId })
    this.setData({ cancelling: false })
    if (!res.ok) {
      wx.showToast({ title: res.message || '取消失败', icon: 'none' })
      await this.reload()
      return
    }
    invalidateSnapshot()
    navigateBackAfterSuccess('已取消')
  },

  onPickDate(e) {
    const slotDate = String((e.detail && e.detail.value) || '')
    const nextLabel = buildSlotLabel(slotDate, this.data.slotStart, this.data.slotEnd)
    this.setData({
      slotDate,
      deliverySlotInput: nextLabel || this.data.deliverySlotInput,
    })
  },

  onPickStart(e) {
    const slotStart = String((e.detail && e.detail.value) || '')
    const nextLabel = buildSlotLabel(this.data.slotDate, slotStart, this.data.slotEnd)
    this.setData({
      slotStart,
      deliverySlotInput: nextLabel || this.data.deliverySlotInput,
    })
  },

  onPickEnd(e) {
    const slotEnd = String((e.detail && e.detail.value) || '')
    const nextLabel = buildSlotLabel(this.data.slotDate, this.data.slotStart, slotEnd)
    this.setData({
      slotEnd,
      deliverySlotInput: nextLabel || this.data.deliverySlotInput,
    })
  },

  onFulfillmentChange(e) {
    const fulfillmentTypeDraft = String((e && e.detail && e.detail.value) || 'delivery')
    const patch = { fulfillmentTypeDraft }
    if (fulfillmentTypeDraft !== 'delivery') {
      if (this._manualAddrSuggestTimer) clearTimeout(this._manualAddrSuggestTimer)
      this._manualAddrSuggestTimer = null
      this._manualAddrSuggestReqId = (this._manualAddrSuggestReqId || 0) + 1
      this._isPickingManualAddrSuggestion = false
      this._ignoreNextManualAddrLine1Input = null
      patch.manualAddressSuggestions = []
      patch.manualAddressLine1Focused = false
    }
    this.setData(patch)
  },

  onAddressModeChange(e) {
    const v = String((e && e.detail && e.detail.value) || 'saved')
    const addressMode = v === 'manual' ? 'manual' : 'saved'
    if (addressMode === 'saved' && !(this.data.customerAddresses || []).length) {
      wx.showToast({ title: '客户暂无已存地址', icon: 'none' })
      this.setData({ addressMode: 'manual' })
      return
    }
    const patch = { addressMode }
    if (addressMode !== 'manual') {
      if (this._manualAddrSuggestTimer) clearTimeout(this._manualAddrSuggestTimer)
      this._manualAddrSuggestTimer = null
      this._manualAddrSuggestReqId = (this._manualAddrSuggestReqId || 0) + 1
      this._isPickingManualAddrSuggestion = false
      this._ignoreNextManualAddrLine1Input = null
      patch.manualAddressSuggestions = []
      patch.manualAddressLine1Focused = false
    }
    this.setData(patch)
  },

  onPickSavedAddress(e) {
    const idx = Number((e && e.detail && e.detail.value) || 0)
    const arr = this.data.customerAddresses || []
    const picked = arr[idx]
    if (!picked) return
    const next = {
      selectedAddressId: String(picked.id || ''),
      selectedAddressIndex: idx,
    }
    const phone = normalizePhone(picked.phone || '')
    if (phone) next.phoneDraft = formatPhoneDisplay(phone) || phone
    this.setData(next)
  },

  onPhoneInput(e) {
    const v = normalizePhoneInputDigits(e && e.detail && e.detail.value)
    this.setData({ phoneDraft: v })
  },

  onPhoneBlur() {
    this.setData({ phoneDraft: formatPhoneBlurValue(this.data.phoneDraft) })
  },

  onManualAddressInput(e) {
    const key = String((e.currentTarget.dataset && e.currentTarget.dataset.k) || '').trim()
    if (!key) return
    const current = {
      ...(this.data.manualAddress || {}),
    }
    const rawValue = String((e && e.detail && e.detail.value) || '')
    current[key] = key === 'phone' ? normalizePhoneInputDigits(rawValue) : rawValue
    if (key === 'country') current[key] = current[key].toUpperCase()
    this.setData({ manualAddress: current })
  },

  onManualAddressPhoneBlur() {
    this.setData({
      manualAddress: {
        ...(this.data.manualAddress || {}),
        phone: formatPhoneBlurValue(this.data.manualAddress && this.data.manualAddress.phone),
      },
    })
  },

  onManualAddressLine1Input(e) {
    if (this._isPickingManualAddrSuggestion) return
    const value = String((e && e.detail && e.detail.value) || '')
    const ignore = this._ignoreNextManualAddrLine1Input
    if (ignore) {
      this._ignoreNextManualAddrLine1Input = null
      if (value === String(ignore.value || '')) return
    }
    this.setData({
      manualAddress: {
        ...(this.data.manualAddress || {}),
        line1: value,
      },
    })
    if (this.data.fulfillmentTypeDraft !== 'delivery') return
    if (this.data.addressMode !== 'manual') return
    this.debouncedManualAddressSuggest(value)
  },

  onManualAddressLine1Focus() {
    this._ignoreNextManualAddrLine1Input = null
    this.setData({ manualAddressLine1Focused: true })
  },

  onManualAddressLine1Blur() {
    if (this._isPickingManualAddrSuggestion) return
    this.setData({ manualAddressLine1Focused: false, manualAddressSuggestions: [] })
  },

  onManualAddressSuggestionTouchStart() {
    this._isPickingManualAddrSuggestion = true
  },

  debouncedManualAddressSuggest(q) {
    const s = String(q || '').trim()
    if (this._manualAddrSuggestTimer) clearTimeout(this._manualAddrSuggestTimer)
    if (s.length < 3) {
      this.setData({ manualAddressSuggestions: [] })
      return
    }
    const reqId = (this._manualAddrSuggestReqId || 0) + 1
    this._manualAddrSuggestReqId = reqId
    this._manualAddrSuggestTimer = setTimeout(() => {
      this.fetchManualAddressSuggestions(s, reqId)
    }, 250)
  },

  async fetchManualAddressSuggestions(q, reqId) {
    const res = await suggestAddressDirect(q, 5)
    if (reqId !== this._manualAddrSuggestReqId) return
    if (this._isPickingManualAddrSuggestion || !this.data.manualAddressLine1Focused) return
    const latestLine1 = String((this.data.manualAddress && this.data.manualAddress.line1) || '').trim()
    if (latestLine1 !== String(q || '').trim()) return
    if (!res.ok || !Array.isArray(res.suggestions)) {
      this.setData({ manualAddressSuggestions: [] })
      return
    }
    this.setData({ manualAddressSuggestions: res.suggestions })
  },

  pickManualAddressSuggestion(e) {
    if (this._manualAddrSuggestTimer) clearTimeout(this._manualAddrSuggestTimer)
    this._manualAddrSuggestTimer = null
    this._manualAddrSuggestReqId = (this._manualAddrSuggestReqId || 0) + 1
    const idx = Number((e.currentTarget.dataset && e.currentTarget.dataset.i) || 0)
    const s = (this.data.manualAddressSuggestions || [])[idx]
    if (!s) {
      this._isPickingManualAddrSuggestion = false
      return
    }
    const current = this.data.manualAddress || {}
    const previousLine1 = String(current.line1 || '')
    this.setData({
      manualAddress: {
        ...current,
        line1: line1FromSuggestion(s),
        postalCode: String(s.postalCode || '').trim(),
        city: String(s.city || '').trim(),
      },
      manualAddressSuggestions: [],
      manualAddressLine1Focused: false,
    })
    this._ignoreNextManualAddrLine1Input = {
      value: previousLine1,
    }
    const clearPickingFlag = () => {
      this._isPickingManualAddrSuggestion = false
    }
    wx.hideKeyboard({
      complete: clearPickingFlag,
    })
  },

  onRemarkInput(e) {
    this.setData({ remarkDraft: String((e && e.detail && e.detail.value) || '') })
  },

  async onExportLabelPdf() {
    const orderId = String(this.data.orderId || '').trim()
    if (!orderId || this.data.exportingLabelPdf) return
    this.setData({ exportingLabelPdf: true })
    try {
      await exportAndOpenOrderLabelsPdf({
        sourceType: 'order',
        orderId,
      })
    } finally {
      this.setData({ exportingLabelPdf: false })
    }
  },

  async saveRemarkDraft() {
    const order = this.data.order
    if (!order || !this.data.orderId) return { ok: true, changed: false }
    if (!this.data.canEditItems) return { ok: true, changed: false }
    const currentRemark = String((order && order.remark) || '').trim()
    const nextRemark = String(this.data.remarkDraft || '').trim()
    if (currentRemark === nextRemark) return { ok: true, changed: false }
    const res = await call('admin', 'updateOrderRemark', {
      orderId: this.data.orderId,
      remark: nextRemark,
    })
    if (!res.ok) {
      wx.showToast({ title: res.message || '保存备注失败', icon: 'none' })
      await this.reload()
      return { ok: false, changed: false }
    }
    return { ok: true, changed: true }
  },

  async trySaveFulfillmentDraft() {
    const order = this.data.order
    if (!order) return { ok: true, changed: false }
    const nextType = this.data.fulfillmentTypeDraft === 'pickup' ? 'pickup' : 'delivery'
    const payload = { orderId: this.data.orderId, fulfillmentType: nextType }
    let nextSlotLabel = ''
    const oldPhone = normalizePhone(order && order.contact && order.contact.phone)
    const nextPhone = normalizePhone(this.data.phoneDraft)
    if (nextPhone && !isPhoneValid(nextPhone)) {
      wx.showToast({ title: '请填写有效电话', icon: 'none' })
      return { ok: false, changed: false }
    }
    if (nextPhone !== oldPhone) payload.phone = nextPhone

    let nextAddressCompareKey = ''
    const oldAddressId = String((order && order.addressId) || '').trim()
    const oldAddressCompareKey = JSON.stringify(
      oldAddressId
        ? { mode: 'saved', addressId: oldAddressId, address: null }
        : { mode: 'manual', addressId: '', address: normalizeManualAddress(order && order.address) }
    )
    if (nextType === 'delivery') {
      if (!nextPhone || !isPhoneValid(nextPhone)) {
        wx.showToast({ title: '配送单需有效电话', icon: 'none' })
        return { ok: false, changed: false }
      }
      if (this.data.addressMode === 'saved') {
        const addressId = String(this.data.selectedAddressId || '').trim()
        if (!addressId) {
          wx.showToast({ title: '请选择客户地址', icon: 'none' })
          return { ok: false, changed: false }
        }
        payload.addressId = addressId
        nextAddressCompareKey = JSON.stringify({ mode: 'saved', addressId, address: null })
      } else {
        const manualAddress = normalizeManualAddress(this.data.manualAddress || {})
        if (!isManualAddressValid(manualAddress)) {
          wx.showToast({ title: '请填写完整法国地址', icon: 'none' })
          return { ok: false, changed: false }
        }
        payload.address = manualAddress
        nextAddressCompareKey = JSON.stringify({ mode: 'manual', addressId: '', address: manualAddress })
      }
      nextSlotLabel = buildSlotLabel(this.data.slotDate, this.data.slotStart, this.data.slotEnd)
      if (!nextSlotLabel) nextSlotLabel = String(this.data.deliverySlotInput || '').trim()
      if (!nextSlotLabel) {
        wx.showToast({ title: '请先选择配送时间段', icon: 'none' })
        return { ok: false, changed: false }
      }
      const hasStructured = this.data.slotDate && this.data.slotStart && this.data.slotEnd
      if (hasStructured) {
        payload.deliverySlotDate = this.data.slotDate
        payload.deliverySlotStartTime = this.data.slotStart
        payload.deliverySlotEndTime = this.data.slotEnd
      } else {
        payload.deliveryTimeSlotLabel = nextSlotLabel
      }
    }
    const oldType = String(order.fulfillmentType || '')
    const oldSlotLabel = String(order.deliveryTimeSlotLabelSnapshot || '').trim()
    const hasTypeChange = nextType !== oldType
    const hasSlotChange = nextType === 'delivery' && nextSlotLabel && nextSlotLabel !== oldSlotLabel
    const hasPhoneChange = nextPhone !== oldPhone
    const hasAddressChange = nextType === 'delivery' ? nextAddressCompareKey !== oldAddressCompareKey : false
    if (!hasTypeChange && !hasSlotChange && !hasPhoneChange && !hasAddressChange) {
      return { ok: true, changed: false }
    }

    const res = await call('admin', 'updateOrderFulfillment', payload)
    if (!res.ok) {
      await showErrorDialog(
        {
          message: res.message || '保存交货方式失败',
          code: res.code || '',
          detail: {
            action: 'admin.updateOrderFulfillment',
            payload,
            backendDetail: res.detail || '',
          },
        },
        {
          title: '保存交货方式失败',
        }
      )
      return { ok: false, changed: false }
    }
    return { ok: true, changed: true }
  },

  async onApproveNow() {
    if (this.data.approving || !this.data.isPendingReview) return
    this.setData({ approving: true })
    const res = await call('admin', 'approvePendingOrderNow', {
      orderId: this.data.orderId,
      deliveryTimeSlotLabel: String(this.data.deliverySlotInput || '').trim(),
    })
    this.setData({ approving: false })
    if (!res.ok) {
      wx.showToast({ title: res.message || '确认失败', icon: 'none' })
      return
    }
    invalidateSnapshot()
    wx.showToast({ title: '已确认', icon: 'success' })
    await this.reload()
  },
})
