const { call } = require('../../../utils/api')
const {
  decorateOrder,
  buildEditableItems,
  calcEditableTotals,
  applyQtyDelta,
  removeDish,
  buildPayloadItems,
} = require('../../../utils/order-editor')

Page({
  data: {
    orderId: '',
    order: null,
    canEditItems: false,
    canCancelOrder: false,
    editableItems: [],
    editableTotals: { qty: 0, amountEuro: '0.00' },
    saving: false,
    cancelling: false,
  },

  onLoad(query) {
    const orderId = (query && query.orderId) || ''
    this.setData({ orderId })
    this.reload()
  },

  async reload() {
    const res = await call('admin', 'getOrderDetail', { orderId: this.data.orderId })
    if (!res.ok) {
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }
    const rawOrder = res.data && res.data.order
    const order = rawOrder ? decorateOrder(rawOrder) : null
    const canEditItems = !!(rawOrder && rawOrder.status === 'ACTIVE')
    const editableItems = buildEditableItems(rawOrder)
    this.setData({
      order,
      canEditItems,
      canCancelOrder: canEditItems,
      editableItems,
      editableTotals: calcEditableTotals(editableItems),
    })
  },

  onQtyChange(e) {
    if (!this.data.canEditItems) return
    const dishId = String((e.detail && e.detail.dishId) || '').trim()
    const delta = Number(e.detail && e.detail.delta)
    if (!dishId || !Number.isFinite(delta)) return
    const editableItems = applyQtyDelta(this.data.editableItems, dishId, delta)
    this.setData({
      editableItems,
      editableTotals: calcEditableTotals(editableItems),
    })
  },

  onRemoveItem(e) {
    if (!this.data.canEditItems) return
    const dishId = String((e.detail && e.detail.dishId) || '').trim()
    if (!dishId) return
    const editableItems = removeDish(this.data.editableItems, dishId)
    this.setData({
      editableItems,
      editableTotals: calcEditableTotals(editableItems),
    })
  },

  async onSaveItems() {
    if (!this.data.canEditItems || this.data.saving) return
    const payloadItems = buildPayloadItems(this.data.editableItems)
    const hasAny = payloadItems.some((it) => it.qty > 0)
    if (!hasAny) {
      wx.showToast({ title: '订单不能清空，请点取消整单', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    const res = await call('admin', 'updateOrderItems', {
      orderId: this.data.orderId,
      items: payloadItems,
    })
    this.setData({ saving: false })
    if (!res.ok) {
      wx.showToast({ title: res.message || '保存失败', icon: 'none' })
      await this.reload()
      return
    }
    wx.showToast({ title: '已保存', icon: 'success' })
    await this.reload()
  },

  async onCancelOrder() {
    if (!this.data.canCancelOrder || this.data.cancelling) return
    const modalRes = await new Promise((resolve) => {
      wx.showModal({
        title: '确认取消订单',
        content: '取消后默认不计入统计导出。',
        confirmColor: '#d93025',
        success: resolve,
        fail: () => resolve({ confirm: false }),
      })
    })
    if (!modalRes.confirm) return
    this.setData({ cancelling: true })
    const res = await call('admin', 'cancelOrder', { orderId: this.data.orderId })
    this.setData({ cancelling: false })
    if (!res.ok) {
      wx.showToast({ title: res.message || '取消失败', icon: 'none' })
      await this.reload()
      return
    }
    wx.showToast({ title: '已取消', icon: 'success' })
    await this.reload()
  },
})
