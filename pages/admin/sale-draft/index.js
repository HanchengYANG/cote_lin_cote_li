const { call } = require('../../../utils/api')
const { fenToYuan } = require('../../../utils/format')

function applySelected(dishes, dishIds) {
  const set = new Set(dishIds || [])
  return dishes.map((d) => ({ ...d, selected: set.has(d._id) }))
}

Page({
  data: {
    sale: null,
    dishes: [],
    saving: false,
    opening: false,
  },

  onShow() {
    this.reload()
  },

  async reload() {
    const [saleRes, dishesRes] = await Promise.all([
      call('admin', 'getOrCreateDraft'),
      call('admin', 'listDishes'),
    ])
    if (!saleRes.ok) {
      wx.showToast({ title: saleRes.message || '加载失败', icon: 'none' })
      return
    }
    const sale = saleRes.data.sale
    let dishes = []
    if (dishesRes.ok) {
      dishes = (dishesRes.data.dishes || []).map((d) => ({
        ...d,
        priceYuan: fenToYuan(d.priceFen || 0),
      }))
    }
    dishes = applySelected(dishes, sale.dishIds || [])
    this.setData({ sale, dishes })
  },

  onSlotLabel(e) {
    const sale = { ...this.data.sale, deliveryTimeSlotLabel: e.detail.value }
    this.setData({ sale })
  },

  onNote(e) {
    const sale = { ...this.data.sale, note: e.detail.value }
    this.setData({ sale })
  },

  onDishSelect(e) {
    const ids = e.detail.value || []
    const sale = { ...this.data.sale, dishIds: ids }
    const dishes = applySelected(this.data.dishes, ids)
    this.setData({ sale, dishes })
  },

  async save() {
    const sale = this.data.sale
    const label = String(sale.deliveryTimeSlotLabel || '').trim()
    if (!label) {
      wx.showToast({ title: '请填写配送时间段', icon: 'none' })
      return
    }
    if (!sale.dishIds || sale.dishIds.length === 0) {
      wx.showToast({ title: '请至少选择一个菜品', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    const res = await call('admin', 'updateSaleDraft', {
      saleId: sale._id,
      deliveryTimeSlotLabel: label,
      note: String(sale.note || '').trim(),
      dishIds: sale.dishIds,
    })
    this.setData({ saving: false })
    if (!res.ok) {
      wx.showToast({ title: res.message || '保存失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已保存', icon: 'success' })
    this.reload()
  },

  async openSale() {
    const sale = this.data.sale
    const label = String(sale.deliveryTimeSlotLabel || '').trim()
    if (!label) {
      wx.showToast({ title: '请填写配送时间段', icon: 'none' })
      return
    }
    if (!sale.dishIds || sale.dishIds.length === 0) {
      wx.showToast({ title: '请至少选择一个菜品', icon: 'none' })
      return
    }
    this.setData({ opening: true })
    // Ensure latest draft content is saved before opening.
    const saveRes = await call('admin', 'updateSaleDraft', {
      saleId: sale._id,
      deliveryTimeSlotLabel: label,
      note: String(sale.note || '').trim(),
      dishIds: sale.dishIds,
    })
    if (!saveRes.ok) {
      this.setData({ opening: false })
      wx.showToast({ title: saveRes.message || '保存失败', icon: 'none' })
      return
    }

    const res = await call('admin', 'openSale', { saleId: sale._id })
    this.setData({ opening: false })
    if (!res.ok) {
      wx.showToast({ title: res.message || '开单失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已开单', icon: 'success' })
    wx.navigateBack()
  },
})
