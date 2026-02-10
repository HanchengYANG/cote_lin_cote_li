const { call } = require('../../../utils/api')
const { formatTime } = require('../../../utils/format')
const { wxp } = require('../../../utils/wxprom')

const TYPE_OPTIONS = [
  { label: '订单明细', value: 'ORDER_DETAIL' },
  { label: '菜品汇总', value: 'DISH_SUMMARY' },
  { label: '客户与地址清单', value: 'CUSTOMER_ADDRESS' },
]

Page({
  data: {
    saleOptions: [{ label: '加载中...', value: '' }],
    saleIndex: 0,
    saleLabel: '加载中...',
    typeOptions: TYPE_OPTIONS,
    typeIndex: 0,
    typeLabel: TYPE_OPTIONS[0].label,
    includeCancelled: false,
    exporting: false,
    canExport: false,
  },

  onLoad(query) {
    this.prefSaleId = (query && query.saleId) || ''
  },

  onShow() {
    this.reload()
  },

  async reload() {
    const salesRes = await call('admin', 'listSales', { limit: 50 })
    if (!salesRes.ok) {
      wx.showToast({ title: salesRes.message || '加载失败', icon: 'none' })
      return
    }
    const sales = salesRes.data.sales || []
    const opts = sales.map((s) => ({
      label: `${s.status} ${formatTime(s.createdAt)}`,
      value: s._id,
    }))
    if (opts.length === 0) opts.push({ label: '暂无开单', value: '' })
    let saleIndex = 0
    if (this.prefSaleId) {
      const idx = opts.findIndex((o) => o.value === this.prefSaleId)
      saleIndex = idx >= 0 ? idx : 0
    }
    this.setData({ saleOptions: opts, saleIndex })
    this.recompute()
  },

  onPickSale(e) {
    this.setData({ saleIndex: Number(e.detail.value || 0) })
    this.recompute()
  },

  onPickType(e) {
    this.setData({ typeIndex: Number(e.detail.value || 0) })
    this.recompute()
  },

  onIncludeCancelled(e) {
    this.setData({ includeCancelled: !!(e.detail.value && e.detail.value.length) })
  },

  recompute() {
    const saleId = this.data.saleOptions[this.data.saleIndex] && this.data.saleOptions[this.data.saleIndex].value
    const saleLabel =
      (this.data.saleOptions[this.data.saleIndex] && this.data.saleOptions[this.data.saleIndex].label) || '未选择'
    const typeLabel =
      (this.data.typeOptions[this.data.typeIndex] && this.data.typeOptions[this.data.typeIndex].label) || '未选择'
    this.setData({ canExport: !!saleId, saleLabel, typeLabel })
  },

  async doExport() {
    if (!this.data.canExport || this.data.exporting) return
    const saleId = this.data.saleOptions[this.data.saleIndex].value
    const exportType = this.data.typeOptions[this.data.typeIndex].value
    this.setData({ exporting: true })
    const res = await call('admin', 'export', {
      saleId,
      exportType,
      includeCancelled: !!this.data.includeCancelled,
    })
    this.setData({ exporting: false })
    if (!res.ok) {
      wx.showToast({ title: res.message || '导出失败', icon: 'none' })
      return
    }
    const fileID = res.data.fileID
    const fileType = 'xls'
    wx.showLoading({ title: '下载中...' })
    try {
      const dl = await wxp(wx.cloud.downloadFile, { fileID })
      wx.hideLoading()
      await wxp(wx.openDocument, { filePath: dl.tempFilePath, fileType, showMenu: true })
    } catch (err) {
      wx.hideLoading()
      wx.showToast({ title: (err && err.errMsg) || '打开失败', icon: 'none' })
    }
  },
})
