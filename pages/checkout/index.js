const { call } = require('../../utils/api')
const { centToEuro } = require('../../utils/format')

const PAYMENT_METHODS = [
  { label: '现金', value: 'cash' },
  { label: '微信转账', value: 'wechat_transfer' },
  { label: '到店付款', value: 'pickup_pay' },
]

function normalizePhone(phone) {
  return String(phone || '')
    .trim()
    .replace(/[.\-\s]/g, '')
}

function isPhoneValid(phone) {
  const s = normalizePhone(phone)
  return /^(\+?\d{6,20})$/.test(s)
}

function isAddressValid(addr) {
  if (!addr) return false
  const line1 = String(addr.line1 || '').trim()
  const postalCode = String(addr.postalCode || '').trim()
  const city = String(addr.city || '').trim()
  return !!(line1 && city && /^\d{5}$/.test(postalCode))
}

function findPaymentMethodIndex(value) {
  const idx = PAYMENT_METHODS.findIndex((x) => x.value === value)
  return idx >= 0 ? idx : 0
}

function outOfStockMessage(detail) {
  const list = detail && Array.isArray(detail.items) ? detail.items : []
  if (list.length === 0) return '库存不足，请返回菜单调整'
  const first = list[0]
  const name = String((first && first.dishName) || '')
  const remain = Number(first && first.remainingQty)
  if (name && Number.isFinite(remain)) return `${name} 库存不足（剩余 ${Math.max(0, remain)}）`
  if (name) return `${name} 库存不足`
  return '库存不足，请返回菜单调整'
}

Page({
  data: {
    sale: null,
    saleId: '',
    cartItems: [],
    lines: [],
    totalAmountEuro: '0.00',
    hasExistingOrder: false,

    fulfillmentType: 'delivery',
    phone: '',
    address: { line1: '', line2: '', postalCode: '', city: '', country: 'FR' },
    acceptDeliverySlot: false,
    addrSuggestions: [],
    suggesting: false,

    paymentMethodLabels: PAYMENT_METHODS,
    paymentMethodIndex: 0,
    paymentMethodLabel: PAYMENT_METHODS[0].label,

    remark: '',
    submitting: false,
    submitDisabled: true,
    submitDisabledReason: '',
  },

  async onLoad() {
    const cart = wx.getStorageSync('checkout_cart')
    if (!cart || !cart.saleId || !Array.isArray(cart.items) || cart.items.length === 0) {
      wx.showToast({ title: '购物车为空', icon: 'none' })
      wx.navigateBack()
      return
    }
    this.setData({ saleId: cart.saleId, cartItems: cart.items })
    await this.reload()
    this.recalcLines()
    this.recomputeSubmitDisabled()
  },

  async reload() {
    const res = await call('customer', 'getCurrentSale')
    if (!res.ok || !res.data || !res.data.sale) {
      this.setData({ sale: null, lines: [], totalAmountEuro: '0.00' })
      this.recomputeSubmitDisabled()
      return
    }
    const sale = res.data.sale
    if (sale._id !== this.data.saleId) {
      // Sale changed while user was checking out.
      wx.showToast({ title: '开单已变化，请重新下单', icon: 'none' })
      wx.removeStorageSync('checkout_cart')
      wx.navigateBack()
      return
    }
    const dishesById = {}
    for (const d of res.data.dishes || []) dishesById[d._id] = d
    let existingOrder = null
    const orderRes = await call('customer', 'getMySaleOrder', { saleId: sale._id })
    if (orderRes.ok && orderRes.data && orderRes.data.order) existingOrder = orderRes.data.order

    const next = {
      sale,
      dishesById,
      hasExistingOrder: !!existingOrder,
    }
    if (existingOrder) {
      const method = String((existingOrder.payment && existingOrder.payment.method) || 'cash')
      const methodIdx = findPaymentMethodIndex(method)
      next.fulfillmentType = existingOrder.fulfillmentType || 'delivery'
      next.phone = String((existingOrder.contact && existingOrder.contact.phone) || '')
      next.address =
        existingOrder.fulfillmentType === 'delivery' && existingOrder.address
          ? {
              line1: String(existingOrder.address.line1 || ''),
              line2: String(existingOrder.address.line2 || ''),
              postalCode: String(existingOrder.address.postalCode || ''),
              city: String(existingOrder.address.city || ''),
              country: 'FR',
            }
          : { line1: '', line2: '', postalCode: '', city: '', country: 'FR' }
      next.acceptDeliverySlot = existingOrder.fulfillmentType === 'delivery'
      next.paymentMethodIndex = methodIdx
      next.paymentMethodLabel = PAYMENT_METHODS[methodIdx].label
      next.remark = String(existingOrder.remark || '')
    }
    this.setData(next)
    this.recomputeSubmitDisabled()
  },

  recalcLines() {
    const dishesById = this.data.dishesById || {}
    const lines = []
    let totalCents = 0
    for (const it of this.data.cartItems) {
      const dish = dishesById[it.dishId]
      if (!dish) continue
      const qty = Number(it.qty || 0)
      if (qty <= 0) continue
      const unitPriceCents = Number(dish.priceCents || 0)
      const lineTotalCents = unitPriceCents * qty
      totalCents += lineTotalCents
      lines.push({
        dishId: it.dishId,
        name: dish.name,
        qty,
        unitPriceCents,
        unitPriceEuro: centToEuro(unitPriceCents),
        lineTotalEuro: centToEuro(lineTotalCents),
      })
    }
    this.setData({
      lines,
      totalAmountEuro: centToEuro(totalCents),
    })
  },

  onFulfillmentChange(e) {
    const v = e.detail.value
    this.setData({
      fulfillmentType: v,
      // Reset accept flag when leaving delivery mode.
      acceptDeliverySlot: v === 'delivery' ? this.data.acceptDeliverySlot : false,
    })
    this.recomputeSubmitDisabled()
  },

  onPhoneInput(e) {
    this.setData({ phone: e.detail.value })
    this.recomputeSubmitDisabled()
  },

  onAddr(e) {
    const k = e.currentTarget.dataset.k
    const address = { ...this.data.address, [k]: e.detail.value }
    this.setData({ address })
    this.recomputeSubmitDisabled()
  },

  onLine1Input(e) {
    const address = { ...this.data.address, line1: e.detail.value }
    this.setData({ address })
    this.recomputeSubmitDisabled()
    this.debouncedSuggest(address.line1)
  },

  debouncedSuggest(q) {
    const s = String(q || '').trim()
    if (this._suggestTimer) clearTimeout(this._suggestTimer)
    if (s.length < 3) {
      this.setData({ addrSuggestions: [] })
      return
    }
    this._suggestTimer = setTimeout(() => {
      this.fetchSuggestions(s)
    }, 300)
  },

  async fetchSuggestions(q) {
    this.setData({ suggesting: true })
    const res = await call('customer', 'suggestAddress', { q, limit: 5 })
    this.setData({ suggesting: false })
    if (!res.ok) {
      this.setData({ addrSuggestions: [] })
      return
    }
    this.setData({ addrSuggestions: res.data.suggestions || [] })
  },

  pickSuggestion(e) {
    const i = Number(e.currentTarget.dataset.i)
    const s = (this.data.addrSuggestions || [])[i]
    if (!s) return
    const address = {
      ...this.data.address,
      line1: s.line1 || s.label || '',
      postalCode: s.postalCode || '',
      city: s.city || '',
      country: 'FR',
    }
    this.setData({ address, addrSuggestions: [] })
    this.recomputeSubmitDisabled()
  },

  onAcceptChange(e) {
    const arr = (e && e.detail && e.detail.value) || []
    const accept = Array.isArray(arr) ? arr.includes('accept') : false
    this.setData({ acceptDeliverySlot: accept })
    this.recomputeSubmitDisabled()
  },

  onPaymentMethodPick(e) {
    const idx = Number(e.detail.value || 0)
    const label = (PAYMENT_METHODS[idx] && PAYMENT_METHODS[idx].label) || PAYMENT_METHODS[0].label
    this.setData({ paymentMethodIndex: idx, paymentMethodLabel: label })
  },

  onRemarkInput(e) {
    this.setData({ remark: e.detail.value })
  },

  recomputeSubmitDisabled() {
    let disabled = false
    let reason = ''
    if (this.data.submitting) disabled = true
    if (!this.data.sale) {
      disabled = true
      reason = '当前没有开单，无法下单'
    }
    if (!disabled && !isPhoneValid(this.data.phone)) {
      disabled = true
      reason = '请填写正确的电话（仅数字，可带+号）'
    }
    if (this.data.fulfillmentType === 'delivery') {
      if (!disabled && !isAddressValid(this.data.address)) {
        disabled = true
        reason = '请填写法国地址（line1 / postal code / city）'
      }
      if (!disabled && !this.data.acceptDeliverySlot) {
        disabled = true
        reason = '请勾选“我接受该时间段”'
      }
    }
    this.setData({ submitDisabled: disabled, submitDisabledReason: reason })
  },

  async submit() {
    if (this.data.submitDisabled) return
    this.setData({ submitting: true })
    this.recomputeSubmitDisabled()
    const paymentMethod = PAYMENT_METHODS[this.data.paymentMethodIndex].value
    const payload = {
      saleId: this.data.saleId,
      fulfillmentType: this.data.fulfillmentType,
      phone: normalizePhone(this.data.phone),
      address: this.data.fulfillmentType === 'delivery' ? this.data.address : null,
      acceptDeliverySlot: this.data.fulfillmentType === 'delivery' ? !!this.data.acceptDeliverySlot : false,
      items: this.data.cartItems,
      payment: { method: paymentMethod },
      remark: String(this.data.remark || '').trim(),
    }
    const res = await call('customer', 'createOrder', payload)
    this.setData({ submitting: false })
    this.recomputeSubmitDisabled()
    if (!res.ok) {
      if (res.code === 'OUT_OF_STOCK') {
        wx.showToast({ title: outOfStockMessage(res.detail), icon: 'none' })
        await this.reload()
        this.recalcLines()
        return
      }
      wx.showToast({ title: res.message || '下单失败', icon: 'none' })
      return
    }
    wx.removeStorageSync('checkout_cart')
    const orderId = res.data && res.data.orderId
    wx.redirectTo({ url: `/pages/order-success/index?orderId=${encodeURIComponent(orderId)}` })
  },
})
