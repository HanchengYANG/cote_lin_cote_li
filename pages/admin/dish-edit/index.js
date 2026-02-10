const { call } = require('../../../utils/api')
const { fenToYuan } = require('../../../utils/format')

function yuanToFen(str) {
  const s = String(str || '').trim()
  if (!s) return 0
  const n = Number(s)
  if (Number.isNaN(n)) return 0
  return Math.round(n * 100)
}

Page({
  data: {
    dishId: '',
    name: '',
    priceYuan: '',
    isActive: true,
    saving: false,
  },

  async onLoad(query) {
    const dishId = (query && query.dishId) || ''
    this.setData({ dishId })
    if (!dishId) return
    const res = await call('admin', 'getDish', { dishId })
    if (!res.ok) {
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }
    const d = res.data.dish
    this.setData({
      name: d.name || '',
      priceYuan: fenToYuan(d.priceFen || 0),
      isActive: !!d.isActive,
    })
  },

  onName(e) {
    this.setData({ name: e.detail.value })
  },

  onPrice(e) {
    this.setData({ priceYuan: e.detail.value })
  },

  onActive(e) {
    this.setData({ isActive: !!e.detail.value })
  },

  async save() {
    const name = String(this.data.name || '').trim()
    const priceFen = yuanToFen(this.data.priceYuan)
    if (!name) {
      wx.showToast({ title: '请填写名称', icon: 'none' })
      return
    }
    if (priceFen <= 0) {
      wx.showToast({ title: '请填写价格', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    const res = await call('admin', 'upsertDish', {
      dishId: this.data.dishId || null,
      name,
      priceFen,
      isActive: !!this.data.isActive,
    })
    this.setData({ saving: false })
    if (!res.ok) {
      wx.showToast({ title: res.message || '保存失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已保存', icon: 'success' })
    wx.navigateBack()
  },
})

