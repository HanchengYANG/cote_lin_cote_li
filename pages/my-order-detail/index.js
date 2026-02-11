const { call } = require('../../utils/api')
const { formatTime, centToEuro } = require('../../utils/format')

function formatAddress(addr) {
  if (!addr) return ''
  const parts = [addr.line1, addr.line2, addr.postalCode, addr.city, addr.country].filter(Boolean)
  return parts.join(' ')
}

function decorateOrder(o) {
  const statusText = o.status === 'CANCELLED' ? '已取消' : '有效'
  const fulfillmentText = o.fulfillmentType === 'pickup' ? '自取' : '配送'
  const items = (o.items || []).map((it) => ({
    ...it,
    lineTotalEuro: centToEuro(it.lineTotalCents || 0),
  }))
  const totals = o.totals || { amountCents: 0, qty: 0 }
  return {
    ...o,
    statusText,
    fulfillmentText,
    createdAtText: formatTime(o.createdAt),
    addressText: formatAddress(o.address),
    items,
    totals: {
      qty: totals.qty || 0,
      amountEuro: centToEuro(totals.amountCents || 0),
    },
  }
}

function buildEditableItems(order) {
  const src = (order && Array.isArray(order.items)) ? order.items : []
  return src.map((it) => {
    const unitPriceCents = Number(it.unitPriceCents || 0)
    const qty = Number(it.qty || 0)
    return {
      dishId: it.dishId,
      dishName: it.dishName,
      unitPriceCents,
      unitPriceEuro: centToEuro(unitPriceCents),
      qty,
      lineTotalEuro: centToEuro(unitPriceCents * qty),
    }
  })
}

function calcEditableTotals(items) {
  let qty = 0
  let amountCents = 0
  for (const it of (items || [])) {
    const q = Number(it.qty || 0)
    const p = Number(it.unitPriceCents || 0)
    if (q <= 0 || !Number.isFinite(p)) continue
    qty += q
    amountCents += q * p
  }
  return {
    qty,
    amountEuro: centToEuro(amountCents),
  }
}

function outOfStockMessage(detail) {
  const list = detail && Array.isArray(detail.items) ? detail.items : []
  if (list.length === 0) return '库存不足，请调整后重试'
  const first = list[0]
  const name = String((first && first.dishName) || '')
  const remain = Number(first && first.remainingQty)
  if (name && Number.isFinite(remain)) return `${name} 库存不足（剩余 ${Math.max(0, remain)}）`
  if (name) return `${name} 库存不足`
  return '库存不足，请调整后重试'
}

Page({
  data: {
    orderId: '',
    order: null,
    canEdit: false,
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
    const canEdit = !!(rawOrder && rawOrder.status === 'ACTIVE' && activeSale && activeSale._id === rawOrder.saleId)
    this.setData({ order, canEdit, editableItems, editableTotals })
  },

  bumpItemQty(e) {
    if (!this.data.canEdit) return
    const dishId = e.currentTarget.dataset.id
    const delta = Number(e.currentTarget.dataset.delta || 0)
    const editableItems = (this.data.editableItems || []).map((it) => {
      if (it.dishId !== dishId) return it
      const nextQty = Math.max(0, Number(it.qty || 0) + delta)
      return {
        ...it,
        qty: nextQty,
        lineTotalEuro: centToEuro(Number(it.unitPriceCents || 0) * nextQty),
      }
    })
    this.setData({
      editableItems,
      editableTotals: calcEditableTotals(editableItems),
    })
  },

  removeItem(e) {
    if (!this.data.canEdit) return
    const dishId = e.currentTarget.dataset.id
    const editableItems = (this.data.editableItems || []).map((it) => {
      if (it.dishId !== dishId) return it
      return { ...it, qty: 0, lineTotalEuro: '0.00' }
    })
    this.setData({
      editableItems,
      editableTotals: calcEditableTotals(editableItems),
    })
  },

  async saveItems() {
    if (!this.data.canEdit || this.data.saving) return
    const payloadItems = (this.data.editableItems || []).map((it) => ({
      dishId: it.dishId,
      qty: Number(it.qty || 0),
    }))
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

  async cancelOrder() {
    if (!this.data.canEdit || this.data.cancelling) return
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
