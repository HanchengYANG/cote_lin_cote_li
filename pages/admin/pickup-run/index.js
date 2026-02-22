const { call } = require('../../../utils/api')
const { formatTime, centToEuro } = require('../../../utils/format')
const { createPage } = require('../../../utils/create-page')

function buildSaleLabel(sale) {
  if (!sale) return '未知开单'
  const status = saleStatusText(sale.status)
  const ts = formatTime(sale.createdAt)
  return `${status}${ts ? ` ${ts}` : ''}`
}

function saleStatusText(status) {
  const v = String(status || '').trim()
  if (v === 'DRAFT') return '草稿'
  if (v === 'OPEN') return '开单中'
  if (v === 'CLOSED') return '已截单'
  if (v === 'FULFILLING') return '配送中'
  if (v === 'COMPLETED') return '完成'
  return v || '未知'
}

function pickSaleIndex(options, prefSaleId, currentValue) {
  if (!Array.isArray(options) || options.length === 0) return 0
  if (prefSaleId) {
    const idx = options.findIndex((o) => o.value === prefSaleId)
    if (idx >= 0) return idx
  }
  if (currentValue) {
    const idx = options.findIndex((o) => o.value === currentValue)
    if (idx >= 0) return idx
  }
  const openIdx = options.findIndex((o) => o.status === 'OPEN')
  if (openIdx >= 0) return openIdx
  const closedIdx = options.findIndex((o) => o.status === 'CLOSED')
  if (closedIdx >= 0) return closedIdx
  const fulfillingIdx = options.findIndex((o) => o.status === 'FULFILLING')
  if (fulfillingIdx >= 0) return fulfillingIdx
  return 0
}

function paymentMethodLabel(method) {
  return String(method || '') === 'wechat_transfer' ? '转账' : '现金'
}

function paidStatusLabel(status) {
  return String(status || '') === 'PAID' ? '已收款' : '未收款'
}

function handoffStatusLabel(status) {
  return String(status || '') === 'DELIVERED' ? '已交付' : '未交付'
}

function decorateRunOrder(order) {
  const o = order || {}
  const isPickup = String(o.fulfillmentType || '') === 'pickup'
  const amountCents = Number(o.totals && o.totals.amountCents) || 0
  return {
    ...o,
    customerNameText: String(o.customerNickname || '').trim() || '匿名客户',
    amountEuro: centToEuro(amountCents),
    phoneText: String((o.contact && o.contact.phone) || '').trim() || '-',
    fulfillmentText: isPickup ? '自取' : '配送',
    addressDisplay: isPickup ? '自取' : String(o.addressText || '').trim() || '地址未填写',
    paymentMethodText: paymentMethodLabel(o.payment && o.payment.method),
    paidStatusText: paidStatusLabel(o.payment && o.payment.paidStatus),
    handoffStatusText: handoffStatusLabel(o.handoffStatus),
    isPaid: String(o.payment && o.payment.paidStatus) === 'PAID',
    isDelivered: String(o.handoffStatus || '') === 'DELIVERED',
  }
}

function readDatasetString(e, key) {
  const dataset = (e && e.currentTarget && e.currentTarget.dataset) || {}
  return String(dataset[key] || '').trim()
}

createPage({
  data: {
    initialLoading: true,
    initialLoaded: false,
    loadingSales: false,
    loadingRun: false,
    operatingOrderId: '',
    saleOptions: [{ label: '加载中...', value: '', status: '' }],
    saleIndex: 0,
    saleLabel: '加载中...',
    sale: null,
    canOperate: false,
    summary: {
      totalActiveOrders: 0,
      deliveredOrders: 0,
      paidOrders: 0,
      doneOrders: 0,
      remainingOrders: 0,
    },
    orders: [],
    appendedHint: '',
  },

  onLoad(query) {
    this.prefSaleId = String((query && query.saleId) || '').trim()
  },

  onShow() {
    this.reload()
  },

  async reload() {
    if (this.data.loadingSales) return
    this.setData({ loadingSales: true })
    const finishInitial = () => {
      if (this.data.initialLoading || !this.data.initialLoaded) {
        this.setData({ initialLoading: false, initialLoaded: true })
      }
    }
    try {
      const salesRes = await call('admin', 'listPickupSales', { limit: 50, includeCompleted: true })
      if (!salesRes.ok) {
        finishInitial()
        this.setData({
          saleOptions: [{ label: '加载失败', value: '', status: '' }],
          saleIndex: 0,
          saleLabel: '加载失败',
          sale: null,
          canOperate: false,
          orders: [],
          appendedHint: '',
        })
        wx.showToast({ title: salesRes.message || '加载失败', icon: 'none' })
        return
      }
      const sales = Array.isArray(salesRes.data && salesRes.data.sales) ? salesRes.data.sales : []
      const opts = sales.map((s) => ({
        label: buildSaleLabel(s),
        value: String(s._id || ''),
        status: String(s.status || ''),
      }))
      if (!opts.length) opts.push({ label: '暂无可自取执行开单', value: '', status: '' })
      const currentValue = (this.data.saleOptions[this.data.saleIndex] && this.data.saleOptions[this.data.saleIndex].value) || ''
      const saleIndex = pickSaleIndex(opts, this.prefSaleId, currentValue)
      const picked = opts[saleIndex] || { label: '未选择', value: '' }
      this.setData({
        saleOptions: opts,
        saleIndex,
        saleLabel: picked.label || '未选择',
      })
      finishInitial()
      await this.loadRun()
    } finally {
      this.setData({ loadingSales: false })
    }
  },

  onPickSale(e) {
    const saleIndex = Number((e.detail && e.detail.value) || 0)
    const picked = this.data.saleOptions[saleIndex] || { label: '未选择', value: '' }
    this.setData({
      saleIndex,
      saleLabel: picked.label || '未选择',
      appendedHint: '',
    })
    this.loadRun()
  },

  async loadRun() {
    const option = this.data.saleOptions[this.data.saleIndex] || null
    const saleId = String((option && option.value) || '').trim()
    const finishInitial = () => {
      if (this.data.initialLoading || !this.data.initialLoaded) {
        this.setData({ initialLoading: false, initialLoaded: true })
      }
    }
    if (!saleId) {
      this.setData({
        sale: null,
        canOperate: false,
        orders: [],
        appendedHint: '',
        summary: { totalActiveOrders: 0, deliveredOrders: 0, paidOrders: 0, doneOrders: 0, remainingOrders: 0 },
      })
      finishInitial()
      return
    }
    if (this.data.loadingRun) return
    this.setData({ loadingRun: true })
    const res = await call('admin', 'getPickupRun', { saleId })
    this.setData({ loadingRun: false })
    finishInitial()
    if (!res.ok) {
      this.setData({
        sale: null,
        canOperate: false,
        orders: [],
        appendedHint: '',
        summary: { totalActiveOrders: 0, deliveredOrders: 0, paidOrders: 0, doneOrders: 0, remainingOrders: 0 },
      })
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }
    const rawOrders = Array.isArray(res.data && res.data.orders) ? res.data.orders : []
    this.setData({
      sale: res.data && res.data.sale ? { ...res.data.sale, statusText: saleStatusText(res.data.sale.status) } : null,
      canOperate: !!(res.data && res.data.canOperate),
      summary:
        (res.data && res.data.summary) ||
        { totalActiveOrders: 0, deliveredOrders: 0, paidOrders: 0, doneOrders: 0, remainingOrders: 0 },
      orders: rawOrders.map(decorateRunOrder),
      appendedHint: '',
    })
  },

  goOrderDetail(e) {
    const orderId = readDatasetString(e, 'id')
    if (!orderId) return
    wx.navigateTo({ url: `/pages/admin/order-detail/index?orderId=${encodeURIComponent(orderId)}` })
  },

  async onToggleHandoff(e) {
    if (!this.data.canOperate || this.data.loadingRun) return
    const orderId = readDatasetString(e, 'id')
    const current = readDatasetString(e, 'handoff')
    if (!orderId) return
    const next = current === 'DELIVERED' ? 'PENDING' : 'DELIVERED'
    const msg = next === 'DELIVERED' ? '已标记送达' : '已撤销送达'
    await this.applyOrderProgress(orderId, { handoffStatus: next }, msg)
  },

  async onTogglePaid(e) {
    if (!this.data.canOperate || this.data.loadingRun) return
    const orderId = readDatasetString(e, 'id')
    const current = readDatasetString(e, 'paid')
    if (!orderId) return
    const next = current === 'PAID' ? 'UNPAID' : 'PAID'
    const msg = next === 'PAID' ? '已标记收款' : '已撤销收款'
    await this.applyOrderProgress(orderId, { paidStatus: next }, msg)
  },

  async applyOrderProgress(orderId, patch, successTitle) {
    if (this.data.operatingOrderId) return
    const saleId = String((this.data.sale && this.data.sale._id) || '').trim()
    this.setData({ operatingOrderId: orderId })
    const res = await call('admin', 'updateOrderFulfillmentProgress', {
      orderId,
      saleId,
      ...patch,
    })
    this.setData({ operatingOrderId: '' })
    if (!res.ok) {
      wx.showToast({ title: res.message || '更新失败', icon: 'none' })
      await this.loadRun()
      return
    }
    wx.showToast({ title: successTitle || '已更新', icon: 'success' })
    await this.loadRun()
  },
})
