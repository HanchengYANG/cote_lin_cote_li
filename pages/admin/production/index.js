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

createPage({
  data: {
    initialLoading: true,
    initialLoaded: false,
    loadingSales: false,
    loadingBoard: false,
    operatingDishId: '',
    saleOptions: [{ label: '加载中...', value: '', status: '' }],
    saleIndex: 0,
    saleLabel: '加载中...',
    sale: null,
    canEdit: false,
    production: {
      totalNeedQty: 0,
      totalPreparedQty: 0,
      completionPercent: 0,
      items: [],
    },
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
      const salesRes = await call('admin', 'listFulfillmentSales', { limit: 50, includeCompleted: true })
      if (!salesRes.ok) {
        finishInitial()
        this.setData({
          saleOptions: [{ label: '加载失败', value: '', status: '' }],
          saleIndex: 0,
          saleLabel: '加载失败',
          sale: null,
          canEdit: false,
          production: { totalNeedQty: 0, totalPreparedQty: 0, completionPercent: 0, items: [] },
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
      finishInitial()
      await this.loadBoard()
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
    })
    this.loadBoard()
  },

  async loadBoard() {
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
        canEdit: false,
        production: { totalNeedQty: 0, totalPreparedQty: 0, completionPercent: 0, items: [] },
      })
      finishInitial()
      return
    }
    if (this.data.loadingBoard) return
    this.setData({ loadingBoard: true })
    const res = await call('admin', 'getSaleProductionBoard', { saleId })
    this.setData({ loadingBoard: false })
    finishInitial()
    if (!res.ok) {
      this.setData({
        sale: null,
        canEdit: false,
        production: { totalNeedQty: 0, totalPreparedQty: 0, completionPercent: 0, items: [] },
      })
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }
    const sale = res.data && res.data.sale ? res.data.sale : null
    const production = (res.data && res.data.production) || { totalNeedQty: 0, totalPreparedQty: 0, completionPercent: 0, items: [] }
    this.setData({
      sale: sale ? { ...sale, statusText: saleStatusText(sale.status) } : null,
      canEdit: !!(res.data && res.data.canEdit),
      production: {
        totalNeedQty: Number(production.totalNeedQty || 0),
        totalPreparedQty: Number(production.totalPreparedQty || 0),
        completionPercent: Number(production.completionPercent || 0),
        items: (Array.isArray(production.items) ? production.items : []).map(decorateProductionItem),
      },
    })
  },

  async onAdjustPrepared(e) {
    if (!this.data.canEdit || this.data.loadingBoard || this.data.operatingDishId) return
    const dishId = readDatasetString(e, 'id')
    const delta = readDatasetNumber(e, 'delta', 0)
    if (!dishId || !delta) return
    const saleId = String((this.data.sale && this.data.sale._id) || '').trim()
    if (!saleId) return
    const item = (this.data.production.items || []).find((it) => String(it.dishId || '') === dishId)
    if (!item) return
    const preparedQty = Math.max(0, Number(item.preparedQty || 0) + delta)
    this.setData({ operatingDishId: dishId })
    const res = await call('admin', 'updateSaleProductionProgress', { saleId, dishId, preparedQty })
    this.setData({ operatingDishId: '' })
    if (!res.ok) {
      wx.showToast({ title: res.message || '更新失败', icon: 'none' })
      await this.loadBoard()
      return
    }
    const production = (res.data && res.data.production) || { totalNeedQty: 0, totalPreparedQty: 0, completionPercent: 0, items: [] }
    this.setData({
      production: {
        totalNeedQty: Number(production.totalNeedQty || 0),
        totalPreparedQty: Number(production.totalPreparedQty || 0),
        completionPercent: Number(production.completionPercent || 0),
        items: (Array.isArray(production.items) ? production.items : []).map(decorateProductionItem),
      },
    })
  },
})

