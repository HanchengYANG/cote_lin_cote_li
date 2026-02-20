const { call } = require('../../utils/api')
const { centToEuro } = require('../../utils/format')
const { createPage } = require('../../utils/create-page')

function normalizeImageUrls(input) {
  if (!Array.isArray(input)) return []
  return input
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .slice(0, 10)
}

createPage({
  data: {
    dishId: '',
    loading: true,
    dish: null,
  },

  onLoad(query) {
    const dishId = (query && query.dishId) || ''
    this.setData({ dishId })
    this.reload()
  },

  async reload() {
    this.setData({ loading: true })
    const res = await call('customer', 'getDishDetail', { dishId: this.data.dishId })
    this.setData({ loading: false })
    if (!res.ok) {
      this.setData({ dish: null })
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }
    const d = res.data && res.data.dish
    if (!d) {
      this.setData({ dish: null })
      return
    }
    this.setData({
      dish: {
        ...d,
        priceEuro: centToEuro(d.priceCents || 0),
        imageUrls: normalizeImageUrls(d.imageUrls || []),
      },
    })
  },

  copyMd() {
    const md = (this.data.dish && this.data.dish.descMd) || ''
    if (!md) return
    wx.setClipboardData({ data: md })
  },
})
