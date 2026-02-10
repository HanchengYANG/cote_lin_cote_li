const { call } = require('../../../utils/api')
const { fenToYuan } = require('../../../utils/format')

Page({
  data: {
    dishes: [],
  },

  onShow() {
    this.reload()
  },

  async reload() {
    const res = await call('admin', 'listDishes')
    if (!res.ok) {
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }
    const dishes = (res.data.dishes || []).map((d) => ({
      ...d,
      priceYuan: fenToYuan(d.priceFen || 0),
    }))
    this.setData({ dishes })
  },

  add() {
    wx.navigateTo({ url: '/pages/admin/dish-edit/index' })
  },

  edit(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: `/pages/admin/dish-edit/index?dishId=${encodeURIComponent(id)}` })
  },

  async toggle(e) {
    const id = e.currentTarget.dataset.id
    const isActive = !!e.detail.value
    const res = await call('admin', 'toggleDishActive', { dishId: id, isActive })
    if (!res.ok) {
      wx.showToast({ title: res.message || '更新失败', icon: 'none' })
      this.reload()
      return
    }
    wx.showToast({ title: '已更新', icon: 'success' })
  },
})

