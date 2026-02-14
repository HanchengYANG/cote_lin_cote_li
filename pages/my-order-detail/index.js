const { call } = require('../../utils/api')
const {
  decorateOrder,
  buildEditableItems,
  calcEditableTotals,
  applyQtyDelta,
  removeDish,
  buildPayloadItems,
  outOfStockMessage,
} = require('../../utils/order-editor')

Page({
  data: {
    orderId: '',
    order: null,
    canEdit: false,
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
    const [res, saleRes] = await Promise.all([
      call('customer', 'getMyOrderDetail', { orderId: this.data.orderId }),
      call('customer', 'getCurrentSale'),
    ])
    if (!res.ok) {
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }
    const rawOrder = res.data && res.data.order
    const order = rawOrder ? decorateOrder(rawOrder) : null
    const editableItems = buildEditableItems(rawOrder)
    const editableTotals = calcEditableTotals(editableItems)
    const activeSale = saleRes && saleRes.ok && saleRes.data && saleRes.data.sale
    const canEdit = !!(
      rawOrder &&
      (rawOrder.status === 'ACTIVE' || rawOrder.status === 'PENDING_REVIEW') &&
      activeSale &&
      activeSale._id === rawOrder.saleId
    )
    this.setData({
      order,
      canEdit,
      canCancelOrder: canEdit,
      editableItems,
      editableTotals,
    })
  },

  onQtyChange(e) {
    if (!this.data.canEdit) return
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
    if (!this.data.canEdit) return
    const dishId = String((e.detail && e.detail.dishId) || '').trim()
    if (!dishId) return
    const editableItems = removeDish(this.data.editableItems, dishId)
    this.setData({
      editableItems,
      editableTotals: calcEditableTotals(editableItems),
    })
  },

  async onSaveItems() {
    if (!this.data.canEdit || this.data.saving) return
    const payloadItems = buildPayloadItems(this.data.editableItems)
    const hasAny = payloadItems.some((it) => it.qty > 0)
    if (!hasAny) {
      wx.showToast({ title: '订单不能清空，请点取消整单', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    const res = await call('customer', 'updateMyOrderItems', {
      orderId: this.data.orderId,
      items: payloadItems,
    })
    this.setData({ saving: false })
    if (!res.ok) {
      if (res.code === 'OUT_OF_STOCK') {
        wx.showToast({ title: outOfStockMessage(res.detail), icon: 'none' })
        await this.reload()
        return
      }
      wx.showToast({ title: res.message || '保存失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已保存', icon: 'success' })
    await this.reload()
  },

  async onCancelOrder() {
    if (!this.data.canCancelOrder || this.data.cancelling) return
    const modalRes = await new Promise((resolve) => {
      wx.showModal({
        title: '取消订单',
        content: '确认取消整单吗？',
        confirmColor: '#d93025',
        success: resolve,
        fail: () => resolve({ confirm: false }),
      })
    })
    if (!modalRes.confirm) return
    this.setData({ cancelling: true })
    const res = await call('customer', 'cancelMyOrder', { orderId: this.data.orderId })
    this.setData({ cancelling: false })
    if (!res.ok) {
      wx.showToast({ title: res.message || '取消失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已取消', icon: 'success' })
    await this.reload()
  },
})
