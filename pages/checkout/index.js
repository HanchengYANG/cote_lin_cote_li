const { call } = require('../../utils/api')
const { centToEuro } = require('../../utils/format')
const { outOfStockMessage } = require('../../utils/order-errors')

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

Page({
  data: {
    saleStatus: 'loading', // loading | open | closed
    sale: null,
    cartItems: [],
    lines: [],
    totalAmountEuro: '0.00',
    hasExistingOrder: false,
    dishesById: {},

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
    const cartItems = normalizeCartItems(cart && cart.items)
    if (cartItems.length === 0) {
      wx.showToast({ title: '购物车为空', icon: 'none' })
      wx.navigateBack()
      return
    }
    this.setData({ cartItems })
    await this.reload()
  },

  saveCart() {
    wx.setStorageSync('checkout_cart', {
      items: this.data.cartItems,
      updatedAt: Date.now(),
    })
  },

  async reload() {
    this.setData({ saleStatus: 'loading' })
    const res = await call('customer', 'getCurrentSale')
    if (res && !res.ok) {
      wx.showToast({ title: res.message || '加载开单失败', icon: 'none' })
    }

    if (!res.ok || !res.data || !res.data.sale) {
      this.setData({
        saleStatus: 'closed',
        sale: null,
        hasExistingOrder: false,
        dishesById: {},
      })
      this.recalcLines()
      this.recomputeSubmitDisabled()
      return
    }

    const sale = res.data.sale
    const dishes = Array.isArray(res.data.dishes) ? res.data.dishes : []
    const allowedSet = new Set((sale.dishIds || []).filter(Boolean))
    const dishesById = {}
    for (const d of dishes) dishesById[d._id] = d

    const prevItems = normalizeCartItems(this.data.cartItems)
    const cartItems = prevItems.filter((it) => allowedSet.has(it.dishId))
    const removedCount = prevItems.length - cartItems.length
    if (removedCount > 0) {
      wx.showToast({ title: `已移除 ${removedCount} 个非本次开单菜品`, icon: 'none' })
    }

    let existingOrder = null
    const orderRes = await call('customer', 'getMySaleOrder', { saleId: sale._id })
    if (orderRes.ok && orderRes.data && orderRes.data.order) existingOrder = orderRes.data.order

    const next = {
      saleStatus: 'open',
      sale,
      dishesById,
      cartItems,
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
    this.saveCart()
    this.recalcLines()
    this.recomputeSubmitDisabled()
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
    if (this.data.submitting) {
      disabled = true
      reason = '提交中...'
    }
    if (!disabled && (!this.data.cartItems || this.data.cartItems.length === 0)) {
      disabled = true
      reason = '当前购物车无可下单菜品'
    }
    if (!disabled && this.data.saleStatus === 'loading') {
      disabled = true
      reason = '正在刷新开单状态...'
    }
    if (!disabled && this.data.saleStatus !== 'open') {
      disabled = true
      reason = '当前未开单，暂不可提交订单'
    }
    if (!disabled && !isPhoneValid(this.data.phone)) {
      disabled = true
      reason = '请填写正确的电话（仅数字，可带+号）'
    }
    if (!disabled && this.data.fulfillmentType === 'delivery') {
      if (!isAddressValid(this.data.address)) {
        disabled = true
        reason = '请填写法国地址（line1 / postal code / city）'
      } else if (!this.data.acceptDeliverySlot) {
        disabled = true
        reason = '请勾选“我接受该时间段”'
      }
    }
    this.setData({ submitDisabled: disabled, submitDisabledReason: reason })
  },

  async submit() {
    if (this.data.submitDisabled || this.data.submitting) return
    this.setData({ submitting: true })
    this.recomputeSubmitDisabled()
    const paymentMethod = PAYMENT_METHODS[this.data.paymentMethodIndex].value
    const payload = {
      saleId: this.data.sale && this.data.sale._id,
      fulfillmentType: this.data.fulfillmentType,
      phone: normalizePhone(this.data.phone),
      address: this.data.fulfillmentType === 'delivery' ? this.data.address : null,
      acceptDeliverySlot: this.data.fulfillmentType === 'delivery' ? !!this.data.acceptDeliverySlot : false,
      items: this.data.cartItems.map((it) => ({ dishId: it.dishId, qty: Number(it.qty || 0) })),
      payment: { method: paymentMethod },
      remark: String(this.data.remark || '').trim(),
    }
    const res = await call('customer', 'createOrder', payload)
    this.setData({ submitting: false })
    this.recomputeSubmitDisabled()
    if (!res.ok) {
      if (res.code === 'OUT_OF_STOCK') {
        wx.showToast({ title: outOfStockMessage(res.detail, '库存不足，请返回菜单调整'), icon: 'none' })
        await this.reload()
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
