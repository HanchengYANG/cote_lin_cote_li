const { call } = require('../../../utils/api')
const { centToEuro } = require('../../../utils/format')

function applySelected(dishes, dishIds, limitMap) {
  const set = new Set(dishIds || [])
  return dishes.map((d) => ({
    ...d,
    selected: set.has(d._id),
    limitQtyInput: limitMap[d._id] || '',
  }))
}

Page({
  data: {
    sale: null,
    dishes: [],
    limitMap: {},
    slotDate: '',
    slotStart: '',
    slotEnd: '',
    slotLabel: '',
    activeSale: null,
    openDisabled: false,
    pendingOrders: [],
    pendingSelectedIds: [],
    saving: false,
    opening: false,
  },

  onShow() {
    this.reload()
  },

  async reload() {
    const [saleRes, dishesRes, pendingRes] = await Promise.all([
      call('admin', 'getOrCreateDraft'),
      call('admin', 'listDishes'),
      call('admin', 'listPendingOrders'),
    ])
    if (!saleRes.ok) {
      wx.showToast({ title: saleRes.message || '加载失败', icon: 'none' })
      return
    }
    const sale = saleRes.data.sale
    const limitMap = this.parseLimitMapFromSale(sale)
    let dishes = []
    if (dishesRes.ok) {
      dishes = (dishesRes.data.dishes || []).map((d) => ({
        ...d,
        priceEuro: centToEuro(d.priceCents || 0),
      }))
    }
    dishes = applySelected(dishes, sale.dishIds || [], limitMap)
    const parsed = this.parseSlotFromSale(sale)
    const oldSelected = new Set(this.data.pendingSelectedIds || [])
    const pendingOrders = (pendingRes.ok ? pendingRes.data.orders : [])
      .map((o) => ({
        ...o,
        summary: (o.items || []).map((it) => `${it.dishName}x${it.qty}`).join('，'),
        checked: oldSelected.has(o._id),
      }))
      .sort((a, b) => {
        const ta = a.createdAt ? new Date(a.createdAt).getTime() : 0
        const tb = b.createdAt ? new Date(b.createdAt).getTime() : 0
        return tb - ta
      })
    const pendingSelectedIds = pendingOrders.filter((o) => oldSelected.has(o._id)).map((o) => o._id)

    const dashRes = await call('admin', 'getDashboard')
    const activeSale = (dashRes.ok && dashRes.data && dashRes.data.activeSale) ? dashRes.data.activeSale : null
    const openDisabled = !!(activeSale && activeSale.status === 'OPEN')

    this.setData({
      sale,
      dishes,
      limitMap,
      slotDate: parsed.slotDate,
      slotStart: parsed.slotStart,
      slotEnd: parsed.slotEnd,
      slotLabel: parsed.slotLabel,
      activeSale,
      openDisabled,
      pendingOrders,
      pendingSelectedIds,
    })
  },

  parseSlotFromSale(sale) {
    const slotDate = sale.deliverySlotDate || ''
    const slotStart = sale.deliverySlotStartTime || ''
    const slotEnd = sale.deliverySlotEndTime || ''
    const slotLabel = slotDate && slotStart && slotEnd ? `${slotDate} ${slotStart}-${slotEnd}` : ''
    return { slotDate, slotStart, slotEnd, slotLabel }
  },

  recomputeSlotLabel() {
    const { slotDate, slotStart, slotEnd } = this.data
    if (slotDate && slotStart && slotEnd) return `${slotDate} ${slotStart}-${slotEnd}`
    return ''
  },

  parseLimitMapFromSale(sale) {
    const map = {}
    const cfg = Array.isArray(sale && sale.dishConfigs) ? sale.dishConfigs : []
    for (const it of cfg) {
      const dishId = String((it && it.dishId) || '').trim()
      if (!dishId) continue
      const limitQty = Number(it && it.limitQty)
      if (!Number.isFinite(limitQty) || limitQty < 0) continue
      map[dishId] = String(Math.floor(limitQty))
    }
    for (const dishId of (sale && sale.dishIds) || []) {
      if (!map[dishId]) map[dishId] = ''
    }
    return map
  },

  onPickDate(e) {
    this.setData({ slotDate: e.detail.value })
    this.setData({ slotLabel: this.recomputeSlotLabel() })
  },

  onPickStart(e) {
    this.setData({ slotStart: e.detail.value })
    this.setData({ slotLabel: this.recomputeSlotLabel() })
  },

  onPickEnd(e) {
    this.setData({ slotEnd: e.detail.value })
    this.setData({ slotLabel: this.recomputeSlotLabel() })
  },

  goAdminHome() {
    wx.navigateTo({ url: '/pages/admin/home/index' })
  },

  onNote(e) {
    const sale = { ...this.data.sale, note: e.detail.value }
    this.setData({ sale })
  },

  onDishSelect(e) {
    const ids = e.detail.value || []
    const sale = { ...this.data.sale, dishIds: ids }
    const oldMap = this.data.limitMap || {}
    const limitMap = {}
    for (const id of ids) {
      limitMap[id] = oldMap[id] || ''
    }
    const dishes = applySelected(this.data.dishes, ids, limitMap)
    this.setData({ sale, dishes, limitMap })
  },

  onLimitInput(e) {
    const dishId = e.currentTarget.dataset.id
    const value = String((e.detail && e.detail.value) || '')
    const limitMap = { ...this.data.limitMap, [dishId]: value }
    const dishes = this.data.dishes.map((d) => (d._id === dishId ? { ...d, limitQtyInput: value } : d))
    this.setData({ limitMap, dishes })
  },

  onPendingSelect(e) {
    const ids = Array.isArray(e.detail.value) ? e.detail.value : []
    const idSet = new Set(ids)
    const pendingOrders = (this.data.pendingOrders || []).map((o) => ({ ...o, checked: idSet.has(o._id) }))
    this.setData({ pendingSelectedIds: ids, pendingOrders })
  },

  buildDishConfigs() {
    const dishIds = (this.data.sale && this.data.sale.dishIds) || []
    const limitMap = this.data.limitMap || {}
    const dishConfigs = []
    for (const dishId of dishIds) {
      const raw = String(limitMap[dishId] || '').trim()
      if (!raw) return { ok: false, message: '请给每个菜填写总量' }
      const n = Number(raw)
      if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) {
        return { ok: false, message: '总量必须是非负整数' }
      }
      dishConfigs.push({ dishId, limitQty: Math.floor(n) })
    }
    if (dishConfigs.length === 0) return { ok: false, message: '请至少选择一个菜品' }
    return { ok: true, dishConfigs }
  },

  async save() {
    const sale = this.data.sale
    const label = String(this.recomputeSlotLabel() || '').trim()
    if (!label) {
      wx.showToast({ title: '请填写配送时间段', icon: 'none' })
      return
    }
    if (!sale.dishIds || sale.dishIds.length === 0) {
      wx.showToast({ title: '请至少选择一个菜品', icon: 'none' })
      return
    }
    const cfgBuild = this.buildDishConfigs()
    if (!cfgBuild.ok) {
      wx.showToast({ title: cfgBuild.message, icon: 'none' })
      return
    }
    this.setData({ saving: true })
    const res = await call('admin', 'updateSaleDraft', {
      saleId: sale._id,
      deliveryTimeSlotLabel: label,
      deliverySlotDate: this.data.slotDate || null,
      deliverySlotStartTime: this.data.slotStart || null,
      deliverySlotEndTime: this.data.slotEnd || null,
      note: String(sale.note || '').trim(),
      dishIds: sale.dishIds,
      dishConfigs: cfgBuild.dishConfigs,
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
    if (this.data.opening) return
    if (this.data.openDisabled) {
      wx.showToast({ title: '已有开单中开单，请先截单', icon: 'none' })
      return
    }
    const sale = this.data.sale
    const label = String(this.recomputeSlotLabel() || '').trim()
    if (!label) {
      wx.showToast({ title: '请填写配送时间段', icon: 'none' })
      return
    }
    if (!sale.dishIds || sale.dishIds.length === 0) {
      wx.showToast({ title: '请至少选择一个菜品', icon: 'none' })
      return
    }
    const cfgBuild = this.buildDishConfigs()
    if (!cfgBuild.ok) {
      wx.showToast({ title: cfgBuild.message, icon: 'none' })
      return
    }
    this.setData({ opening: true })
    // Ensure latest draft content is saved before opening.
    const saveRes = await call('admin', 'updateSaleDraft', {
      saleId: sale._id,
      deliveryTimeSlotLabel: label,
      deliverySlotDate: this.data.slotDate || null,
      deliverySlotStartTime: this.data.slotStart || null,
      deliverySlotEndTime: this.data.slotEnd || null,
      note: String(sale.note || '').trim(),
      dishIds: sale.dishIds,
      dishConfigs: cfgBuild.dishConfigs,
    })
    if (!saveRes.ok) {
      this.setData({ opening: false })
      wx.showToast({ title: saveRes.message || '保存失败', icon: 'none' })
      return
    }

    const res = await call('admin', 'openSale', { saleId: sale._id, deferredOrderIds: this.data.pendingSelectedIds || [] })
    this.setData({ opening: false })
    if (!res.ok) {
      if (res.code === 'DEFERRED_ORDER_STOCK_EXCEED' || res.code === 'DEFERRED_ORDER_DISH_MISSING') {
        const first = res.detail && Array.isArray(res.detail.items) && res.detail.items[0]
        let msg = res.message || '勾选的延后订单不满足条件'
        if (first && res.code === 'DEFERRED_ORDER_STOCK_EXCEED') {
          msg = `库存不足：${first.dishId} 需${first.requiredQty}，限${first.limitQty}`
        }
        if (first && res.code === 'DEFERRED_ORDER_DISH_MISSING') {
          msg = `有菜不在本次开单：${first.dishId}`
        }
        wx.showToast({ title: msg, icon: 'none' })
        return
      }
      wx.showToast({ title: res.message || '开单失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已开单', icon: 'success' })
    wx.navigateBack()
  },
})
