const { call } = require('../../../utils/api')
const { centToEuro } = require('../../../utils/format')
const { createPage } = require('../../../utils/create-page')

createPage({
  data: {
    loading: false,
    initialLoading: true,
    initialLoaded: false,
    dishes: [],
  },

  onShow() {
    this.reload()
  },

  async reload() {
    this.setData({ loading: true })
    const finishInitialLoad = () => {
      if (this.data.initialLoading || !this.data.initialLoaded) {
        this.setData({ initialLoading: false, initialLoaded: true })
      }
    }
    const res = await call('admin', 'listDishes')
    this.setData({ loading: false })
    finishInitialLoad()
    if (!res.ok) {
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }
    const dishes = (res.data.dishes || []).map((d) => ({
      ...d,
      priceEuro: centToEuro(d.priceCents || 0),
      thumb: d.thumbUrl || '',
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
