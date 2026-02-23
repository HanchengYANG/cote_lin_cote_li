const { call } = require('../../../utils/api')
const { formatTime, centToEuro } = require('../../../utils/format')
const { invalidateSnapshot } = require('../../../utils/app-snapshot')
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
  const closedIdx = options.findIndex((o) => o.status === 'CLOSED')
  if (closedIdx >= 0) return closedIdx
  const fulfillingIdx = options.findIndex((o) => o.status === 'FULFILLING')
  if (fulfillingIdx >= 0) return fulfillingIdx
  return 0
}

function decoratePrepOrder(order) {
  const o = order || {}
  const amountCents = Number(o.totals && o.totals.amountCents) || 0
  const isPickup = String(o.fulfillmentType || '') === 'pickup'
  return {
    ...o,
    amountEuro: centToEuro(amountCents),
    customerNameText: String(o.customerNickname || '').trim() || '匿名客户',
    fulfillmentText: isPickup ? '自取' : '配送',
    addressDisplay: isPickup ? '自取' : String(o.addressText || '').trim() || '地址未填写',
  }
}

function moveItem(arr, from, to) {
  if (!Array.isArray(arr)) return []
  if (from < 0 || from >= arr.length || to < 0 || to >= arr.length || from === to) return arr.slice()
  const next = arr.slice()
  const [it] = next.splice(from, 1)
  next.splice(to, 0, it)
  return next
}

function readDatasetIndex(e) {
  const dataset = (e && e.currentTarget && e.currentTarget.dataset) || {}
  const raw = dataset.idx
  if (raw === undefined || raw === null || raw === '') return -1
  const idx = Number(raw)
  return Number.isFinite(idx) ? idx : -1
}

createPage({
  data: {
    loadPhase: 'loading',
    loadingSales: false,
    loadingPrep: false,
    saving: false,
    markingPrepDone: false,
    saleOptions: [{ label: '加载中...', value: '', status: '' }],
    saleIndex: 0,
    saleLabel: '加载中...',
    sale: null,
    canEdit: false,
    deliveryOrders: [],
    pickupOrders: [],
    dirty: false,
    deliveryCollapsed: false,
    pickupCollapsed: false,
    deliveryAppendedHint: '',
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
    const finishLoadPhase = () => {
      if (this.data.loadPhase !== 'ready') {
        this.setData({ loadPhase: 'ready' })
      }
    }
    if (this.data.loadPhase !== 'ready') this.setData({ loadPhase: 'loading' })
    try {
      const salesRes = await call('admin', 'listFulfillmentSales', { limit: 50, includeCompleted: true })
      if (!salesRes.ok) {
        finishLoadPhase()
        this.setData({
          saleOptions: [{ label: '加载失败', value: '', status: '' }],
          saleIndex: 0,
          saleLabel: '加载失败',
          sale: null,
          deliveryOrders: [],
          pickupOrders: [],
          canEdit: false,
          dirty: false,
          deliveryAppendedHint: '',
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
      if (!opts.length) opts.push({ label: '暂无可交付开单', value: '', status: '' })
      const currentValue = (this.data.saleOptions[this.data.saleIndex] && this.data.saleOptions[this.data.saleIndex].value) || ''
      const saleIndex = pickSaleIndex(opts, this.prefSaleId, currentValue)
      const picked = opts[saleIndex] || { label: '未选择', value: '' }
      this.setData({
        saleOptions: opts,
        saleIndex,
        saleLabel: picked.label || '未选择',
      })
      finishLoadPhase()
      await this.loadPrep()
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
      dirty: false,
      deliveryAppendedHint: '',
    })
    this.loadPrep()
  },

  async loadPrep() {
    const option = this.data.saleOptions[this.data.saleIndex] || null
    const saleId = String((option && option.value) || '').trim()
    const finishLoadPhase = () => {
      if (this.data.loadPhase !== 'ready') {
        this.setData({ loadPhase: 'ready' })
      }
    }
    if (!saleId) {
      this.setData({
        sale: null,
        canEdit: false,
        deliveryOrders: [],
        pickupOrders: [],
        dirty: false,
        deliveryAppendedHint: '',
      })
      finishLoadPhase()
      return
    }
    if (this.data.loadingPrep) return
    this.setData({ loadingPrep: true })
    const res = await call('admin', 'getSaleFulfillmentPrep', { saleId })
    this.setData({ loadingPrep: false })
    finishLoadPhase()
    if (!res.ok) {
      this.setData({ sale: null, canEdit: false, deliveryOrders: [], pickupOrders: [], dirty: false, deliveryAppendedHint: '' })
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }
    const sale = res.data && res.data.sale ? res.data.sale : null
    const canEdit = !!(res.data && res.data.canEdit)
    const rawDeliveryOrders =
      (res.data && res.data.delivery && Array.isArray(res.data.delivery.orders) && res.data.delivery.orders) || []
    const rawPickupOrders =
      (res.data && res.data.pickup && Array.isArray(res.data.pickup.orders) && res.data.pickup.orders) || []
    const appendedOrderIds =
      (res.data && res.data.delivery && Array.isArray(res.data.delivery.appendedOrderIds) && res.data.delivery.appendedOrderIds) || []
    this.setData({
      sale: sale ? { ...sale, statusText: saleStatusText(sale.status) } : null,
      canEdit,
      deliveryOrders: rawDeliveryOrders.map(decoratePrepOrder),
      pickupOrders: rawPickupOrders.map(decoratePrepOrder),
      dirty: false,
      deliveryAppendedHint: appendedOrderIds.length ? `有 ${appendedOrderIds.length} 个新配送单已自动追加到末尾` : '',
    })
  },

  toggleDeliveryCollapsed() {
    this.setData({ deliveryCollapsed: !this.data.deliveryCollapsed })
  },

  togglePickupCollapsed() {
    this.setData({ pickupCollapsed: !this.data.pickupCollapsed })
  },

  onMoveUp(e) {
    if (!this.data.canEdit || this.data.loadingPrep || this.data.saving || this.data.markingPrepDone) return
    const idx = readDatasetIndex(e)
    if (idx <= 0) return
    this.setData({ deliveryOrders: moveItem(this.data.deliveryOrders, idx, idx - 1), dirty: true })
  },

  onMoveDown(e) {
    if (!this.data.canEdit || this.data.loadingPrep || this.data.saving || this.data.markingPrepDone) return
    const idx = readDatasetIndex(e)
    if (idx < 0 || idx >= this.data.deliveryOrders.length - 1) return
    this.setData({ deliveryOrders: moveItem(this.data.deliveryOrders, idx, idx + 1), dirty: true })
  },

  async onSaveOrder() {
    if (!this.data.canEdit || this.data.saving || this.data.markingPrepDone) return
    const saleId = String((this.data.sale && this.data.sale._id) || '').trim()
    if (!saleId) return
    const orderIds = (this.data.deliveryOrders || []).map((o) => String((o && o._id) || '').trim()).filter(Boolean)
    this.setData({ saving: true })
    const res = await call('admin', 'saveSaleFulfillmentOrder', { saleId, orderIds })
    this.setData({ saving: false })
    if (!res.ok) {
      wx.showToast({ title: res.message || '保存失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '排序已保存', icon: 'success' })
    await this.loadPrep()
  },

  async onMarkPrepDone() {
    if (this.data.markingPrepDone || this.data.saving) return
    const sale = this.data.sale || null
    const saleId = String((sale && sale._id) || '').trim()
    const saleStatus = String((sale && sale.status) || '').trim()
    if (!saleId || saleStatus !== 'CLOSED') return
    this.setData({ markingPrepDone: true })
    const res = await call('admin', 'markSalePrepDone', { saleId })
    this.setData({ markingPrepDone: false })
    if (!res.ok) {
      wx.showToast({ title: res.message || '操作失败', icon: 'none' })
      return
    }
    invalidateSnapshot()
    wx.showToast({ title: '已进入配送中', icon: 'success' })
    await this.reload()
  },
})
