const { call } = require('../../../utils/api')
const { formatTime, centToEuro } = require('../../../utils/format')
const { createPage } = require('../../../utils/create-page')

function buildSaleLabel(sale) {
  if (!sale) return '未知开单'
  const status = String(sale.status || '').trim() || 'UNKNOWN'
  const ts = formatTime(sale.createdAt)
  return `${status}${ts ? ` ${ts}` : ''}`
}

function toSafeInt(n, fallback = 0) {
  const v = Number(n)
  if (!Number.isFinite(v)) return fallback
  return Math.floor(v)
}

function mapReview(data) {
  const raw = data || {}
  const sale = raw.sale || null
  const summary = raw.summary || {}
  const dishSales = Array.isArray(raw.dishSales) ? raw.dishSales : []
  const orders = Array.isArray(raw.orders) ? raw.orders : []

  return {
    sale: sale
      ? {
          ...sale,
          createdAtLabel: formatTime(sale.createdAt),
          deliveryTimeSlotLabel: String(sale.deliveryTimeSlotLabel || '').trim(),
        }
      : null,
    summary: {
      orderCount: toSafeInt(summary.orderCount, 0),
      totalQty: toSafeInt(summary.totalQty, 0),
      revenueCents: toSafeInt(summary.revenueCents, 0),
      revenueEuro: centToEuro(toSafeInt(summary.revenueCents, 0)),
    },
    dishSales: dishSales.map((it) => {
      const qty = toSafeInt(it && it.qty, 0)
      const amountCents = toSafeInt(it && it.amountCents, 0)
      return {
        dishId: String((it && it.dishId) || ''),
        dishName: String((it && it.dishName) || '未知菜品'),
        qty,
        amountCents,
        amountEuro: centToEuro(amountCents),
      }
    }),
    orders: orders.map((o) => {
      const amountCents = toSafeInt(o && o.totals && o.totals.amountCents, 0)
      const qty = toSafeInt(o && o.totals && o.totals.qty, 0)
      const items = Array.isArray(o && o.items) ? o.items : []
      return {
        ...o,
        customerNickname: String((o && o.customerNickname) || '').trim() || '匿名客户',
        createdAtLabel: formatTime(o && o.createdAt),
        fulfillmentLabel: String((o && o.fulfillmentType) || '') === 'delivery' ? '配送' : '自取',
        phone: String((o && o.contact && o.contact.phone) || ''),
        addressText: String((o && o.addressText) || ''),
        remark: String((o && o.remark) || ''),
        itemSummary: items.map((it) => `${it.dishName} x${it.qty}`).join('；'),
        totals: {
          qty,
          amountCents,
          amountEuro: centToEuro(amountCents),
        },
      }
    }),
  }
}

createPage({
  data: {
    loadPhase: 'loading',
    saleOptions: [{ label: '加载中...', value: '' }],
    saleIndex: 0,
    saleLabel: '加载中...',
    loadingReview: false,
    reviewLoaded: false,
    review: null,
    hasSaleSelection: false,
  },

  onLoad(query) {
    this.prefSaleId = String((query && query.saleId) || '').trim()
  },

  onShow() {
    this.reload()
  },

  async reload() {
    const finishLoadPhase = () => {
      if (this.data.loadPhase !== 'ready') {
        this.setData({ loadPhase: 'ready' })
      }
    }
    if (this.data.loadPhase !== 'ready') this.setData({ loadPhase: 'loading' })

    const salesRes = await call('admin', 'listSales', { limit: 50 })
    if (!salesRes.ok) {
      finishLoadPhase()
      this.setData({
        saleOptions: [{ label: '加载失败', value: '' }],
        saleIndex: 0,
        saleLabel: '加载失败',
        hasSaleSelection: false,
        review: null,
        reviewLoaded: true,
        loadingReview: false,
      })
      wx.showToast({ title: salesRes.message || '加载失败', icon: 'none' })
      return
    }

    const sales = (Array.isArray(salesRes.data && salesRes.data.sales) ? salesRes.data.sales : []).filter(
      (s) => String((s && s.status) || '').trim() !== 'DRAFT'
    )
    const opts = sales.map((s) => ({
      label: buildSaleLabel(s),
      value: String(s._id || ''),
    }))
    if (!opts.length) opts.push({ label: '暂无开单', value: '' })

    let saleIndex = 0
    if (this.prefSaleId) {
      const idx = opts.findIndex((o) => o.value === this.prefSaleId)
      if (idx >= 0) saleIndex = idx
    } else if (this.data.saleOptions.length && this.data.saleOptions[0].value) {
      const currentValue = this.data.saleOptions[this.data.saleIndex] && this.data.saleOptions[this.data.saleIndex].value
      const idx = opts.findIndex((o) => o.value === currentValue)
      if (idx >= 0) saleIndex = idx
    }

    const picked = opts[saleIndex] || { label: '未选择', value: '' }
    this.setData({
      saleOptions: opts,
      saleIndex,
      saleLabel: picked.label || '未选择',
      hasSaleSelection: !!picked.value,
      review: null,
      reviewLoaded: false,
    })
    finishLoadPhase()
    await this.loadReview()
  },

  onPickSale(e) {
    const saleIndex = Number(e.detail.value || 0)
    const picked = this.data.saleOptions[saleIndex] || { label: '未选择', value: '' }
    this.setData({
      saleIndex,
      saleLabel: picked.label || '未选择',
      hasSaleSelection: !!picked.value,
      review: null,
      reviewLoaded: false,
    })
    this.loadReview()
  },

  goOrderDetail(e) {
    const orderId = String((e.currentTarget.dataset && e.currentTarget.dataset.id) || '').trim()
    if (!orderId) return
    wx.navigateTo({ url: `/pages/admin/order-detail/index?orderId=${encodeURIComponent(orderId)}` })
  },

  async loadReview() {
    const picked = this.data.saleOptions[this.data.saleIndex] || null
    const saleId = String((picked && picked.value) || '').trim()
    if (!saleId) {
      this.setData({ loadingReview: false, review: null, reviewLoaded: true })
      return
    }
    if (this.data.loadingReview) return

    this.setData({ loadingReview: true })
    const res = await call('admin', 'getSaleReview', { saleId })
    if (!res.ok) {
      this.setData({ loadingReview: false, review: null, reviewLoaded: true })
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }

    this.setData({
      loadingReview: false,
      reviewLoaded: true,
      review: mapReview(res.data),
    })
  },
})
