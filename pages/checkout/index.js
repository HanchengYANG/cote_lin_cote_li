const { call } = require('../../utils/api')
const { fenToYuan } = require('../../utils/format')

const PAYMENT_METHODS = [
  { label: '现金', value: 'cash' },
  { label: '微信转账', value: 'wechat_transfer' },
  { label: '到店付款', value: 'pickup_pay' },
]
const PAID_STATUS = [
  { label: '未收款', value: 'UNPAID' },
  { label: '已收款', value: 'PAID' },
]

function isPhoneValid(phone) {
  const s = String(phone || '').trim()
  return /^(\+?\d{6,20})$/.test(s)
}

function isAddressValid(addr) {
  if (!addr) return false
  const need = ['province', 'city', 'district', 'detail']
  for (const k of need) {
    if (!String(addr[k] || '').trim()) return false
  }
  return true
}

Page({
  data: {
    sale: null,
    saleId: '',
    cartItems: [],
    lines: [],
    totalAmountYuan: '0.00',

    fulfillmentType: 'delivery',
    phone: '',
    address: { province: '', city: '', district: '', detail: '', extra: '' },
    acceptDeliverySlot: false,

    paymentMethodLabels: PAYMENT_METHODS,
    paymentMethodIndex: 0,
    paymentMethodLabel: PAYMENT_METHODS[0].label,
    paidStatusLabels: PAID_STATUS,
    paidStatusIndex: 0,
    paidStatusLabel: PAID_STATUS[0].label,

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
      this.setData({ sale: null, lines: [], totalAmountYuan: '0.00' })
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
    this.setData({ sale, dishesById })
    this.recomputeSubmitDisabled()
  },

  recalcLines() {
    const dishesById = this.data.dishesById || {}
    const lines = []
    let totalFen = 0
    for (const it of this.data.cartItems) {
      const dish = dishesById[it.dishId]
      if (!dish) continue
      const qty = Number(it.qty || 0)
      if (qty <= 0) continue
      const unitPriceFen = Number(dish.priceFen || 0)
      const lineTotalFen = unitPriceFen * qty
      totalFen += lineTotalFen
      lines.push({
        dishId: it.dishId,
        name: dish.name,
        qty,
        unitPriceFen,
        unitPriceYuan: fenToYuan(unitPriceFen),
        lineTotalYuan: fenToYuan(lineTotalFen),
      })
    }
    this.setData({
      lines,
      totalAmountYuan: fenToYuan(totalFen),
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

  onPaidStatusPick(e) {
    const idx = Number(e.detail.value || 0)
    const label = (PAID_STATUS[idx] && PAID_STATUS[idx].label) || PAID_STATUS[0].label
    this.setData({ paidStatusIndex: idx, paidStatusLabel: label })
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
        reason = '请完整填写配送地址（省/市/区/详细地址）'
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
    const paidStatus = PAID_STATUS[this.data.paidStatusIndex].value
    const payload = {
      saleId: this.data.saleId,
      fulfillmentType: this.data.fulfillmentType,
      phone: String(this.data.phone || '').trim(),
      address: this.data.fulfillmentType === 'delivery' ? this.data.address : null,
      acceptDeliverySlot: this.data.fulfillmentType === 'delivery' ? !!this.data.acceptDeliverySlot : false,
      items: this.data.cartItems,
      payment: { method: paymentMethod, paidStatus },
      remark: String(this.data.remark || '').trim(),
    }
    const res = await call('customer', 'createOrder', payload)
    this.setData({ submitting: false })
    this.recomputeSubmitDisabled()
    if (!res.ok) {
      wx.showToast({ title: res.message || '下单失败', icon: 'none' })
      return
    }
    wx.removeStorageSync('checkout_cart')
    const orderId = res.data && res.data.orderId
    wx.redirectTo({ url: `/pages/order-success/index?orderId=${encodeURIComponent(orderId)}` })
  },
})
