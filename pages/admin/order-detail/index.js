const { call } = require('../../../utils/api')
const {
  decorateOrder,
  buildEditableItems,
  calcEditableTotals,
  applyQtyDelta,
  removeDish,
  buildPayloadItems,
} = require('../../../utils/order-editor')

function parseSlotLabel(label) {
  const s = String(label || '').trim()
  const m = s.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})-(\d{2}:\d{2})$/)
  if (!m) return null
  return {
    slotDate: m[1],
    slotStart: m[2],
    slotEnd: m[3],
  }
}

function buildSlotLabel(slotDate, slotStart, slotEnd) {
  const d = String(slotDate || '').trim()
  const s = String(slotStart || '').trim()
  const e = String(slotEnd || '').trim()
  if (!d || !s || !e) return ''
  return `${d} ${s}-${e}`
}

function normalizePhone(phone) {
  return String(phone || '')
    .trim()
    .replace(/[.\-\s]/g, '')
}

function isPhoneValid(phone) {
  return /^(\+?\d{6,20})$/.test(String(phone || '').trim())
}

function normalizeManualAddress(input) {
  const src = input || {}
  return {
    label: String(src.label || '').trim(),
    line1: String(src.line1 || '').trim(),
    line2: String(src.line2 || '').trim(),
    postalCode: String(src.postalCode || '').trim(),
    city: String(src.city || '').trim(),
    country: String(src.country || 'FR')
      .trim()
      .toUpperCase() || 'FR',
  }
}

function isManualAddressValid(addr) {
  const a = normalizeManualAddress(addr)
  if (!a.line1 || !a.city) return false
  if (!/^\d{5}$/.test(a.postalCode)) return false
  if (a.country !== 'FR') return false
  return true
}

Page({
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
    deliverySlotInput: '',
    slotDate: '',
    slotStart: '',
    slotEnd: '',
    approving: false,
    rejecting: false,
    saving: false,
    cancelling: false,
  },

  onLoad(query) {
    const orderId = (query && query.orderId) || ''
    this.setData({ orderId })
    this.reload()
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
    this.setData({
      order,
      canEditItems,
      canCancelOrder: canEditItems,
      isPendingReview,
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
    })
  },

  onQtyChange(e) {
    if (!this.data.canEditItems) return
    const dishId = String((e.detail && e.detail.dishId) || '').trim()
    const delta = Number(e.detail && e.detail.delta)
    if (!dishId || !Number.isFinite(delta)) return
    const editableItems = applyQtyDelta(this.data.editableItems, dishId, delta)
    this.setData({
      editableItems,
      editableTotals: calcEditableTotals(editableItems),
    })
  },

  onRemoveItem(e) {
    if (!this.data.canEditItems) return
    const dishId = String((e.detail && e.detail.dishId) || '').trim()
    if (!dishId) return
    const editableItems = removeDish(this.data.editableItems, dishId)
    this.setData({
      editableItems,
      editableTotals: calcEditableTotals(editableItems),
    })
  },

  async onSaveItems() {
    if (!this.data.canEditItems || this.data.saving) return
    this.setData({ saving: true })
    const fulfillmentOk = await this.trySaveFulfillmentDraft()
    if (!fulfillmentOk) {
      this.setData({ saving: false })
      return
    }
    const payloadItems = buildPayloadItems(this.data.editableItems)
    const hasAny = payloadItems.some((it) => it.qty > 0)
    if (!hasAny) {
      this.setData({ saving: false })
      wx.showToast({ title: '订单不能清空，请点取消整单', icon: 'none' })
      return
    }
    const res = await call('admin', 'updateOrderItems', {
      orderId: this.data.orderId,
      items: payloadItems,
    })
    this.setData({ saving: false })
    if (!res.ok) {
      wx.showToast({ title: res.message || '保存失败', icon: 'none' })
      await this.reload()
      return
    }
    wx.showToast({ title: '已保存', icon: 'success' })
    await this.reload()
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
    wx.showToast({ title: '已取消', icon: 'success' })
    await this.reload()
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
    this.setData({ fulfillmentTypeDraft })
  },

  onAddressModeChange(e) {
    const v = String((e && e.detail && e.detail.value) || 'saved')
    const addressMode = v === 'manual' ? 'manual' : 'saved'
    if (addressMode === 'saved' && !(this.data.customerAddresses || []).length) {
      wx.showToast({ title: '客户暂无已存地址', icon: 'none' })
      this.setData({ addressMode: 'manual' })
      return
    }
    this.setData({ addressMode })
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
    if (phone) next.phoneDraft = phone
    this.setData(next)
  },

  onPhoneInput(e) {
    const v = normalizePhone(e && e.detail && e.detail.value)
    this.setData({ phoneDraft: v })
  },

  onManualAddressInput(e) {
    const key = String((e.currentTarget.dataset && e.currentTarget.dataset.k) || '').trim()
    if (!key) return
    const current = normalizeManualAddress(this.data.manualAddress)
    current[key] = String(e && e.detail && e.detail.value ? e.detail.value : '').trim()
    if (key === 'country') current[key] = current[key].toUpperCase()
    this.setData({ manualAddress: current })
  },

  async trySaveFulfillmentDraft() {
    const order = this.data.order
    if (!order) return true
    const nextType = this.data.fulfillmentTypeDraft === 'pickup' ? 'pickup' : 'delivery'
    const payload = { orderId: this.data.orderId, fulfillmentType: nextType }
    let nextSlotLabel = ''
    const oldPhone = normalizePhone(order && order.contact && order.contact.phone)
    const nextPhone = normalizePhone(this.data.phoneDraft)
    if (nextPhone && !isPhoneValid(nextPhone)) {
      wx.showToast({ title: '请填写有效电话', icon: 'none' })
      return false
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
        return false
      }
      if (this.data.addressMode === 'saved') {
        const addressId = String(this.data.selectedAddressId || '').trim()
        if (!addressId) {
          wx.showToast({ title: '请选择客户地址', icon: 'none' })
          return false
        }
        payload.addressId = addressId
        nextAddressCompareKey = JSON.stringify({ mode: 'saved', addressId, address: null })
      } else {
        const manualAddress = normalizeManualAddress(this.data.manualAddress)
        if (!isManualAddressValid(manualAddress)) {
          wx.showToast({ title: '请填写完整法国地址', icon: 'none' })
          return false
        }
        payload.address = manualAddress
        nextAddressCompareKey = JSON.stringify({ mode: 'manual', addressId: '', address: manualAddress })
      }
      nextSlotLabel = buildSlotLabel(this.data.slotDate, this.data.slotStart, this.data.slotEnd)
      if (!nextSlotLabel) nextSlotLabel = String(this.data.deliverySlotInput || '').trim()
      if (!nextSlotLabel) {
        wx.showToast({ title: '请先选择配送时间段', icon: 'none' })
        return false
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
    if (!hasTypeChange && !hasSlotChange && !hasPhoneChange && !hasAddressChange) return true

    const res = await call('admin', 'updateOrderFulfillment', payload)
    if (!res.ok) {
      wx.showToast({ title: res.message || '保存交货方式失败', icon: 'none' })
      return false
    }
    return true
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
    wx.showToast({ title: '已确认', icon: 'success' })
    await this.reload()
  },

  async onReject() {
    if (this.data.rejecting || !this.data.isPendingReview) return
    const modalRes = await new Promise((resolve) => {
      wx.showModal({
        title: '拒绝订单',
        content: '确认拒绝该待确认订单？',
        confirmColor: '#d93025',
        success: resolve,
        fail: () => resolve({ confirm: false }),
      })
    })
    if (!modalRes.confirm) return
    this.setData({ rejecting: true })
    const res = await call('admin', 'rejectPendingOrder', { orderId: this.data.orderId })
    this.setData({ rejecting: false })
    if (!res.ok) {
      wx.showToast({ title: res.message || '拒绝失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已拒绝', icon: 'success' })
    await this.reload()
  },
})
