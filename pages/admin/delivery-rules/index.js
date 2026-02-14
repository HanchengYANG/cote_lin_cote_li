const { call } = require('../../../utils/api')
const { centToEuro, euroToCent } = require('../../../utils/format')

function buildRowId() {
  return `row_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

function buildRow(city = '', minEuro = '') {
  return {
    _rid: buildRowId(),
    city: String(city || ''),
    minEuro: String(minEuro || ''),
  }
}

function normalizeRows(input) {
  const arr = Array.isArray(input) ? input : []
  return arr.map((x) => ({
    _rid: String((x && x._rid) || '').trim() || buildRowId(),
    city: String((x && x.city) || ''),
    minEuro: String((x && x.minEuro) || ''),
  }))
}

function uniqueCityList(input) {
  const arr = Array.isArray(input) ? input : []
  const out = []
  const seen = new Set()
  for (const s of arr) {
    const city = String((s && s.city) || '').trim()
    const key = city.toLowerCase().replace(/\s+/g, ' ')
    if (!city || seen.has(key)) continue
    seen.add(key)
    out.push(city)
  }
  return out
}

Page({
  data: {
    rows: [],
    defaultMinEuro: '',
    saving: false,
    loading: false,
    citySuggestRowId: '',
    citySuggestions: [],
  },

  onShow() {
    this.reload()
  },

  onUnload() {
    if (this._citySuggestTimer) clearTimeout(this._citySuggestTimer)
  },

  async reload() {
    this.setData({ loading: true })
    const res = await call('admin', 'getDeliveryRules')
    this.setData({ loading: false })
    if (!res.ok) {
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }
    const raw = (res.data && res.data.deliveryMinByCity) || {}
    const rows = Object.keys(raw)
      .map((city) => buildRow(city, centToEuro(raw[city])))
    const defaultMinEuro = centToEuro((res.data && res.data.deliveryMinDefaultCents) || 0)
    this.setData({
      rows,
      defaultMinEuro: defaultMinEuro === '0.00' ? '' : defaultMinEuro,
      citySuggestRowId: '',
      citySuggestions: [],
    })
  },

  onCityInput(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const val = String((e.detail && e.detail.value) || '')
    const rows = normalizeRows(this.data.rows)
    if (!rows[idx]) return
    rows[idx].city = val
    this.setData({ rows })
    this.debouncedSuggestCity(rows[idx]._rid, val)
  },

  onCityFocus(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const rows = normalizeRows(this.data.rows)
    const row = rows[idx]
    if (!row) return
    this.debouncedSuggestCity(row._rid, row.city)
  },

  onCityBlur() {
    setTimeout(() => {
      this.setData({ citySuggestRowId: '', citySuggestions: [] })
    }, 120)
  },

  debouncedSuggestCity(rowId, q) {
    const s = String(q || '')
    if (this._citySuggestTimer) clearTimeout(this._citySuggestTimer)
    if (s.trim().length < 2) {
      this.setData({ citySuggestRowId: '', citySuggestions: [] })
      return
    }
    this._citySuggestTimer = setTimeout(() => {
      this.fetchCitySuggestions(rowId, s)
    }, 220)
  },

  async fetchCitySuggestions(rowId, q) {
    const rows = normalizeRows(this.data.rows)
    if (!rows.some((r) => r._rid === rowId)) return
    const res = await call('customer', 'suggestAddress', { q, limit: 8 })
    if (!res.ok) {
      this.setData({ citySuggestRowId: '', citySuggestions: [] })
      return
    }
    const citySuggestions = uniqueCityList(res.data && res.data.suggestions)
    this.setData({
      citySuggestRowId: citySuggestions.length > 0 ? rowId : '',
      citySuggestions,
    })
  },

  pickCitySuggestion(e) {
    const rowId = String(e.currentTarget.dataset.rid || '')
    const city = String(e.currentTarget.dataset.city || '')
    if (!city) return
    const rows = normalizeRows(this.data.rows)
    const idx = rows.findIndex((r) => r._rid === rowId)
    if (idx < 0) return
    rows[idx].city = city
    this.setData({
      rows,
      citySuggestRowId: '',
      citySuggestions: [],
    })
  },

  onMinInput(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const val = String((e.detail && e.detail.value) || '')
    const rows = normalizeRows(this.data.rows)
    if (!rows[idx]) return
    rows[idx].minEuro = val
    this.setData({ rows })
  },

  onDefaultInput(e) {
    this.setData({ defaultMinEuro: String((e.detail && e.detail.value) || '') })
  },

  addRow() {
    const rows = normalizeRows(this.data.rows)
    rows.push(buildRow('', ''))
    this.setData({
      rows,
      citySuggestRowId: '',
      citySuggestions: [],
    })
  },

  removeRow(e) {
    const idx = Number(e.currentTarget.dataset.idx)
    const rows = normalizeRows(this.data.rows).filter((_, i) => i !== idx)
    this.setData({
      rows,
      citySuggestRowId: '',
      citySuggestions: [],
    })
  },

  buildPayload() {
    const map = {}
    for (const row of normalizeRows(this.data.rows)) {
      if (!row.city && !row.minEuro) continue
      if (!row.city) return { ok: false, message: '有城市为空' }
      const cents = euroToCent(row.minEuro)
      if (!Number.isFinite(cents) || cents <= 0) return { ok: false, message: `城市 ${row.city} 起送价无效` }
      map[row.city] = cents
    }
    const defaultCents = euroToCent(String(this.data.defaultMinEuro || '').trim())
    return {
      ok: true,
      deliveryMinByCity: map,
      deliveryMinDefaultCents: defaultCents > 0 ? defaultCents : 0,
    }
  },

  async save() {
    if (this.data.saving) return
    const payload = this.buildPayload()
    if (!payload.ok) {
      wx.showToast({ title: payload.message, icon: 'none' })
      return
    }
    this.setData({ saving: true })
    const res = await call('admin', 'updateDeliveryRules', {
      deliveryMinByCity: payload.deliveryMinByCity,
      deliveryMinDefaultCents: payload.deliveryMinDefaultCents,
    })
    this.setData({ saving: false })
    if (!res.ok) {
      wx.showToast({ title: res.message || '保存失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已保存', icon: 'success' })
    await this.reload()
  },
})
