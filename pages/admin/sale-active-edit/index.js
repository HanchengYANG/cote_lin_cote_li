const { call } = require('../../../utils/api')
const { centToEuro } = require('../../../utils/format')
const { invalidateSnapshot } = require('../../../utils/app-snapshot')
const { createPage } = require('../../../utils/create-page')

function toSafeInt(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  if (n < 0) return null
  if (Math.floor(n) !== n) return null
  return Math.floor(n)
}

createPage({
  data: {
    sale: null,
    dishes: [],
    slotDate: '',
    slotStart: '',
    slotEnd: '',
    slotLabel: '',
    note: '',
    dishConfigs: [],
    addDishOptions: [],
    addDishIndex: 0,
    addLimitQty: '',
    saving: false,
  },

  onShow() {
    this.reload()
  },

  async reload() {
    const res = await call('admin', 'getActiveSaleEditor')
    if (!res.ok) {
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }
    const sale = res.data && res.data.sale
    const dishes = (res.data && res.data.dishes) || []
    if (!sale) {
      this.setData({ sale: null, dishes: [], dishConfigs: [], addDishOptions: [] })
      return
    }
    const dishMap = new Map(dishes.map((d) => [d._id, d]))
    const configs = Array.isArray(sale.dishConfigs) ? sale.dishConfigs : []
    const dishConfigs = configs.map((cfg) => {
      const dish = dishMap.get(cfg.dishId) || {}
      const soldQty = Number(cfg.soldQty || 0)
      const limitQty = Number(cfg.limitQty || 0)
      return {
        dishId: cfg.dishId,
        name: dish.name || cfg.dishId,
        isActive: !!dish.isActive,
        priceEuro: centToEuro(Number(dish.priceCents || 0)),
        soldQty,
        limitQty,
        limitQtyInput: String(limitQty),
        remainingQty: Math.max(0, limitQty - soldQty),
      }
    })

    const selectedSet = new Set(dishConfigs.map((x) => x.dishId))
    const addDishOptions = dishes
      .filter((d) => d && d.isActive && !selectedSet.has(d._id))
      .map((d) => ({
        dishId: d._id,
        label: `${d.name} €${centToEuro(d.priceCents || 0)}`,
      }))

    const slotDate = sale.deliverySlotDate || ''
    const slotStart = sale.deliverySlotStartTime || ''
    const slotEnd = sale.deliverySlotEndTime || ''
    const slotLabel = slotDate && slotStart && slotEnd ? `${slotDate} ${slotStart}-${slotEnd}` : ''
    this.setData({
      sale,
      dishes,
      slotDate,
      slotStart,
      slotEnd,
      slotLabel,
      note: String(sale.note || ''),
      dishConfigs,
      addDishOptions,
      addDishIndex: 0,
      addLimitQty: '',
    })
  },

  recomputeSlotLabel() {
    const { slotDate, slotStart, slotEnd } = this.data
    if (slotDate && slotStart && slotEnd) return `${slotDate} ${slotStart}-${slotEnd}`
    return ''
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

  onNoteInput(e) {
    this.setData({ note: e.detail.value })
  },

  onLimitInput(e) {
    const dishId = e.currentTarget.dataset.id
    const value = String((e.detail && e.detail.value) || '')
    const dishConfigs = (this.data.dishConfigs || []).map((x) => {
      if (x.dishId !== dishId) return x
      return { ...x, limitQtyInput: value }
    })
    this.setData({ dishConfigs })
  },

  markSoldOut(e) {
    const dishId = e.currentTarget.dataset.id
    const dishConfigs = (this.data.dishConfigs || []).map((x) => {
      if (x.dishId !== dishId) return x
      const next = Math.max(0, Number(x.soldQty || 0))
      return { ...x, limitQtyInput: String(next) }
    })
    this.setData({ dishConfigs })
  },

  onAddDishPick(e) {
    this.setData({ addDishIndex: Number(e.detail.value || 0) })
  },

  onAddLimitInput(e) {
    this.setData({ addLimitQty: String((e.detail && e.detail.value) || '') })
  },

  addDish() {
    const opts = this.data.addDishOptions || []
    if (opts.length === 0) return
    const pick = opts[this.data.addDishIndex]
    if (!pick) return
    const limitQty = toSafeInt(String(this.data.addLimitQty || '').trim())
    if (limitQty === null) {
      wx.showToast({ title: '新增菜总量必须是非负整数', icon: 'none' })
      return
    }
    const dish = (this.data.dishes || []).find((x) => x._id === pick.dishId) || {}
    const dishConfigs = (this.data.dishConfigs || []).concat([
      {
        dishId: pick.dishId,
        name: dish.name || pick.dishId,
        isActive: true,
        priceEuro: centToEuro(Number(dish.priceCents || 0)),
        soldQty: 0,
        limitQty,
        limitQtyInput: String(limitQty),
        remainingQty: limitQty,
      },
    ])
    const selectedSet = new Set(dishConfigs.map((x) => x.dishId))
    const addDishOptions = (this.data.dishes || [])
      .filter((d) => d && d.isActive && !selectedSet.has(d._id))
      .map((d) => ({
        dishId: d._id,
        label: `${d.name} €${centToEuro(d.priceCents || 0)}`,
      }))
    this.setData({
      dishConfigs,
      addDishOptions,
      addDishIndex: 0,
      addLimitQty: '',
    })
  },

  buildDishConfigsForSave() {
    const out = []
    for (const x of (this.data.dishConfigs || [])) {
      const limitQty = toSafeInt(String(x.limitQtyInput || '').trim())
      if (limitQty === null) return { ok: false, message: '每个菜的总量都必须是非负整数' }
      if (limitQty < Number(x.soldQty || 0)) return { ok: false, message: `总量不能小于已售：${x.name}` }
      out.push({ dishId: x.dishId, limitQty })
    }
    if (out.length === 0) return { ok: false, message: '请至少保留一个菜品' }
    return { ok: true, dishConfigs: out }
  },

  async save() {
    const sale = this.data.sale
    if (!sale) return
    const slotLabel = String(this.recomputeSlotLabel() || '').trim()
    if (!slotLabel) {
      wx.showToast({ title: '请填写配送时间段', icon: 'none' })
      return
    }
    const cfgBuild = this.buildDishConfigsForSave()
    if (!cfgBuild.ok) {
      wx.showToast({ title: cfgBuild.message, icon: 'none' })
      return
    }
    this.setData({ saving: true })
    const res = await call('admin', 'updateActiveSaleConfig', {
      saleId: sale._id,
      deliverySlotDate: this.data.slotDate || null,
      deliverySlotStartTime: this.data.slotStart || null,
      deliverySlotEndTime: this.data.slotEnd || null,
      note: String(this.data.note || '').trim(),
      dishConfigs: cfgBuild.dishConfigs,
    })
    this.setData({ saving: false })
    if (!res.ok) {
      wx.showToast({ title: res.message || '保存失败', icon: 'none' })
      return
    }
    invalidateSnapshot()
    wx.showToast({ title: '已保存', icon: 'success' })
    await this.reload()
  },
})
