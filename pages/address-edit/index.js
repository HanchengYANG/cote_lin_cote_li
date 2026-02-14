const { call } = require('../../utils/api')

function normalizeAddress(a) {
  return {
    label: String((a && a.label) || '').trim(),
    line1: String((a && a.line1) || '').trim(),
    line2: String((a && a.line2) || '').trim(),
    postalCode: String((a && a.postalCode) || '').trim(),
    city: String((a && a.city) || '').trim(),
    phone: String((a && a.phone) || '').trim(),
    country: 'FR',
  }
}

function normalizePhone(phone) {
  return String(phone || '')
    .trim()
    .replace(/[.\-\s]/g, '')
}

function isPhoneValid(phone) {
  return /^(\+?\d{6,20})$/.test(normalizePhone(phone))
}

function isAddressValid(a) {
  if (!a) return false
  if (!a.label || !a.line1 || !a.city) return false
  if (!/^\d{5}$/.test(String(a.postalCode || '').trim())) return false
  if (!isPhoneValid(a.phone)) return false
  return true
}

Page({
  data: {
    addressId: '',
    saving: false,
    isEdit: false,
    address: {
      label: '',
      line1: '',
      line2: '',
      postalCode: '',
      city: '',
      phone: '',
      country: 'FR',
    },
    setDefault: false,
    suggestions: [],
  },

  async onLoad(query) {
    const addressId = String((query && query.addressId) || '').trim()
    this.setData({ addressId, isEdit: !!addressId })
    if (!addressId) return
    const res = await call('customer', 'getMyProfile')
    if (!res.ok || !res.data || !res.data.profile) {
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }
    const p = res.data.profile
    const arr = Array.isArray(p.addresses) ? p.addresses : []
    const found = arr.find((x) => String(x.id || '') === addressId) || null
    if (!found) {
      wx.showToast({ title: '地址不存在', icon: 'none' })
      return
    }
    this.setData({
      address: normalizeAddress(found),
      setDefault: String(p.defaultAddressId || '') === addressId,
    })
  },

  onAddrInput(e) {
    const k = e.currentTarget.dataset.k
    const address = { ...this.data.address, [k]: e.detail.value }
    this.setData({ address })
  },

  onLine1Input(e) {
    const value = e.detail.value
    const address = { ...this.data.address, line1: value }
    this.setData({ address })
    this.debouncedSuggest(value)
  },

  debouncedSuggest(q) {
    const s = String(q || '').trim()
    if (this._timer) clearTimeout(this._timer)
    if (s.length < 3) {
      this.setData({ suggestions: [] })
      return
    }
    this._timer = setTimeout(() => {
      this.fetchSuggestions(s)
    }, 250)
  },

  async fetchSuggestions(q) {
    const res = await call('customer', 'suggestAddress', { q, limit: 5 })
    if (!res.ok) {
      this.setData({ suggestions: [] })
      return
    }
    this.setData({ suggestions: res.data.suggestions || [] })
  },

  pickSuggestion(e) {
    const idx = Number(e.currentTarget.dataset.i)
    const s = (this.data.suggestions || [])[idx]
    if (!s) return
    const address = {
      ...this.data.address,
      line1: s.line1 || s.label || '',
      postalCode: s.postalCode || '',
      city: s.city || '',
    }
    this.setData({ address, suggestions: [] })
  },

  onSetDefault(e) {
    this.setData({ setDefault: !!e.detail.value })
  },

  async save() {
    if (this.data.saving) return
    const address = normalizeAddress(this.data.address)
    address.phone = normalizePhone(address.phone)
    if (!isAddressValid(address)) {
      wx.showToast({ title: '请填写完整地址和电话', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    let res
    if (this.data.isEdit) {
      res = await call('customer', 'updateMyAddress', {
        addressId: this.data.addressId,
        address,
        setDefault: !!this.data.setDefault,
      })
    } else {
      res = await call('customer', 'addMyAddress', {
        address,
        setDefault: !!this.data.setDefault,
      })
    }
    this.setData({ saving: false })
    if (!res.ok) {
      wx.showToast({ title: res.message || '保存失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已保存', icon: 'success' })
    wx.navigateBack()
  },
})
