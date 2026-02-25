const { call } = require('../../../utils/api')
const { formatTime } = require('../../../utils/format')
const { createPage } = require('../../../utils/create-page')

function saleStatusText(status) {
  const v = String(status || '').trim()
  if (v === 'DRAFT') return '草稿'
  if (v === 'OPEN') return '开单中'
  if (v === 'CLOSED') return '已截单'
  if (v === 'FULFILLING') return '配送中'
  if (v === 'COMPLETED') return '完成'
  return v || '未知'
}

function buildSaleLabel(sale) {
  if (!sale) return '未知开单'
  const status = saleStatusText(sale.status)
  const ts = formatTime(sale.createdAt)
  return `${status}${ts ? ` ${ts}` : ''}`
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

function readDatasetString(e, key) {
  const dataset = (e && e.currentTarget && e.currentTarget.dataset) || {}
  return String(dataset[key] || '').trim()
}

function readDatasetNumber(e, key, fallback = 0) {
  const dataset = (e && e.currentTarget && e.currentTarget.dataset) || {}
  const raw = dataset[key]
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function decorateProductionItem(item) {
  const needQty = Math.max(0, Number(item && item.needQty) || 0)
  const preparedQty = Math.max(0, Number(item && item.preparedQty) || 0)
  return {
    ...item,
    needQty,
    preparedQty,
    isDone: needQty > 0 && preparedQty >= needQty,
    isOver: preparedQty > needQty,
  }
}

function buildProductionBoard(raw) {
  const items = (Array.isArray(raw && raw.items) ? raw.items : []).map(decorateProductionItem)
  let totalNeedQty = 0
  let totalPreparedQty = 0
  let totalPreparedCapped = 0
  items.forEach((it) => {
    const needQty = Math.max(0, Number(it.needQty || 0))
    const preparedQty = Math.max(0, Number(it.preparedQty || 0))
    totalNeedQty += needQty
    totalPreparedQty += preparedQty
    totalPreparedCapped += Math.min(needQty, preparedQty)
  })
  const completionPercent =
    totalNeedQty > 0 ? Math.max(0, Math.min(100, Math.round((totalPreparedCapped * 100) / totalNeedQty))) : 0
  return {
    totalNeedQty,
    totalPreparedQty,
    completionPercent,
    items,
  }
}

function emptyProductionBoard() {
  return buildProductionBoard({ items: [] })
}

createPage({
  data: {
    loadPhase: 'loading',
    loadingSales: false,
    loadingBoard: false,
    savingBoard: false,
    completingAll: false,
    productionDirty: false,
    saleOptions: [{ label: '加载中...', value: '', status: '' }],
    saleIndex: 0,
    saleLabel: '加载中...',
    sale: null,
    canEdit: false,
    production: emptyProductionBoard(),
    productionDraft: emptyProductionBoard(),
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
          canEdit: false,
          production: emptyProductionBoard(),
          productionDraft: emptyProductionBoard(),
          productionDirty: false,
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
      if (!opts.length) opts.push({ label: '暂无可生产开单', value: '', status: '' })
      const currentValue = (this.data.saleOptions[this.data.saleIndex] && this.data.saleOptions[this.data.saleIndex].value) || ''
      const saleIndex = pickSaleIndex(opts, this.prefSaleId, currentValue)
      const picked = opts[saleIndex] || { label: '未选择', value: '' }
      this.setData({
        saleOptions: opts,
        saleIndex,
        saleLabel: picked.label || '未选择',
      })
      finishLoadPhase()
      await this.loadBoard()
    } finally {
      this.setData({ loadingSales: false })
    }
  },

  onPickSale(e) {
    const saleIndex = Number((e.detail && e.detail.value) || 0)
    const picked = this.data.saleOptions[saleIndex] || { label: '未选择', value: '' }
    if (saleIndex === this.data.saleIndex) return
    const proceed = () => {
      this.setData({
        saleIndex,
        saleLabel: picked.label || '未选择',
      })
      this.loadBoard()
    }
    if (!this.data.productionDirty) {
      proceed()
      return
    }
    wx.showModal({
      title: '切换开单',
      content: '当前有未保存修改，切换开单会丢失这些修改。是否继续？',
      confirmColor: '#d93025',
      success: (res) => {
        if (res && res.confirm) proceed()
      },
    })
  },

  async loadBoard() {
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
        production: emptyProductionBoard(),
        productionDraft: emptyProductionBoard(),
        productionDirty: false,
      })
      finishLoadPhase()
      return
    }
    if (this.data.loadingBoard) return
    this.setData({ loadingBoard: true })
    const res = await call('admin', 'getSaleProductionBoard', { saleId })
    this.setData({ loadingBoard: false })
    finishLoadPhase()
    if (!res.ok) {
      this.setData({
        sale: null,
        canEdit: false,
        production: emptyProductionBoard(),
        productionDraft: emptyProductionBoard(),
        productionDirty: false,
      })
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }
    const sale = res.data && res.data.sale ? res.data.sale : null
    const production = buildProductionBoard((res.data && res.data.production) || emptyProductionBoard())
    this.setData({
      sale: sale ? { ...sale, statusText: saleStatusText(sale.status) } : null,
      canEdit: !!(res.data && res.data.canEdit),
      production,
      productionDraft: buildProductionBoard(production),
      productionDirty: false,
    })
  },

  async onAdjustPrepared(e) {
    if (!this.data.canEdit || this.data.loadingBoard || this.data.savingBoard || this.data.completingAll) return
    const dishId = readDatasetString(e, 'id')
    const delta = readDatasetNumber(e, 'delta', 0)
    if (!dishId || !delta) return
    const item = (this.data.productionDraft.items || []).find((it) => String(it.dishId || '') === dishId)
    if (!item) return
    const nextItems = (this.data.productionDraft.items || []).map((it) => {
      if (String(it.dishId || '') !== dishId) return { ...it }
      return { ...it, preparedQty: Math.max(0, Number(it.preparedQty || 0) + delta) }
    })
    const productionDraft = buildProductionBoard({ items: nextItems })
    this.setData({
      productionDraft,
      productionDirty: true,
    })
  },

  buildSavePayloadItems(items) {
    return (Array.isArray(items) ? items : [])
      .map((it) => ({
        dishId: String((it && it.dishId) || '').trim(),
        preparedQty: Math.max(0, Number((it && it.preparedQty) || 0)),
      }))
      .filter((it) => it.dishId)
  },

  async saveProductionBoardWithItems(items, { successTitle = '已保存', failTitle = '保存失败' } = {}) {
    const saleId = String((this.data.sale && this.data.sale._id) || '').trim()
    if (!saleId) return false
    this.setData({ savingBoard: true })
    const res = await call('admin', 'saveSaleProductionBoard', {
      saleId,
      items: this.buildSavePayloadItems(items),
    })
    this.setData({ savingBoard: false, completingAll: false })
    if (!res.ok) {
      wx.showToast({ title: res.message || failTitle, icon: 'none' })
      await this.loadBoard()
      return false
    }
    const production = buildProductionBoard((res.data && res.data.production) || emptyProductionBoard())
    this.setData({
      production,
      productionDraft: buildProductionBoard(production),
      productionDirty: false,
    })
    wx.showToast({ title: successTitle, icon: 'success' })
    return true
  },

  async onSaveProductionBoard() {
    if (!this.data.canEdit || this.data.loadingBoard || this.data.savingBoard || this.data.completingAll || !this.data.productionDirty) return
    await this.saveProductionBoardWithItems(this.data.productionDraft.items, { successTitle: '已保存', failTitle: '保存失败' })
  },

  async onCompleteAllPrepared() {
    if (!this.data.canEdit || this.data.loadingBoard || this.data.savingBoard || this.data.completingAll) return
    const items = Array.isArray(this.data.productionDraft.items) ? this.data.productionDraft.items : []
    if (!items.length) return
    const modalRes = await new Promise((resolve) => {
      wx.showModal({
        title: '一键完成',
        content: '将把所有菜品已生产数量设置为需做数量，并立即保存。是否继续？',
        confirmColor: '#d93025',
        success: resolve,
        fail: () => resolve({ confirm: false }),
      })
    })
    if (!modalRes.confirm) return
    const nextItems = items.map((it) => ({ ...it, preparedQty: Math.max(0, Number(it.needQty || 0)) }))
    this.setData({
      productionDraft: buildProductionBoard({ items: nextItems }),
      productionDirty: true,
      completingAll: true,
    })
    const ok = await this.saveProductionBoardWithItems(nextItems, {
      successTitle: '已全部标记完成',
      failTitle: '一键完成失败',
    })
    if (ok) {
      setTimeout(() => {
        wx.navigateBack()
      }, 180)
    }
  },
})
