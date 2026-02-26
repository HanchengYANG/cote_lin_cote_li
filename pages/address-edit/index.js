const { call } = require('../../utils/api')
const { invalidateSnapshot } = require('../../utils/app-snapshot')
const { normalizePhone, normalizePhoneInputDigits, formatPhoneDisplay, formatPhoneBlurValue } = require('../../utils/phone')
const { normalizeFrAddress, isFrAddressValid } = require('../../utils/fr-address')
const { suggestAddressDirect } = require('../../utils/address-suggest')
const { createPage } = require('../../utils/create-page')

function normalizeAddress(a) {
  const normalized = normalizeFrAddress(a)
  return normalized || {
    label: '',
    line1: '',
    line2: '',
    postalCode: '',
    city: '',
    phone: '',
    country: 'FR',
  }
}

function line1FromSuggestion(suggestion) {
  const raw = String((suggestion && (suggestion.line1 || suggestion.label)) || '').trim()
  const parts = raw.split(/\s+/).filter(Boolean)
  if (parts.length >= 2 && String(parts[0]).toLowerCase() === String(parts[1]).toLowerCase()) {
    parts.splice(1, 1)
  }
  return parts.join(' ')
}

createPage({
  data: {
    addressId: '',
    saving: false,
    loadPhase: 'ready',
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
    line1Focused: false,
  },

  async onLoad(query) {
    this._suggestReqId = 0
    this._timer = null
    this._isPickingSuggestion = false
    const addressId = String((query && query.addressId) || '').trim()
    this.setData({
      addressId,
      isEdit: !!addressId,
      loadPhase: addressId ? 'loading' : 'ready',
    })
    if (!addressId) return
    const res = await call('customer', 'getMyProfile')
    this.setData({ loadPhase: 'ready' })
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
      address: {
        ...normalizeAddress(found),
        phone: formatPhoneDisplay(found && found.phone) || normalizePhone(found && found.phone),
      },
      setDefault: String(p.defaultAddressId || '') === addressId,
    })
  },

  onAddrInput(e) {
    const k = e.currentTarget.dataset.k
    const nextValue =
      k === 'phone' ? normalizePhoneInputDigits(e && e.detail && e.detail.value) : (e && e.detail && e.detail.value)
    const address = { ...this.data.address, [k]: nextValue }
    this.setData({ address })
  },

  onPhoneBlur() {
    this.setData({
      address: {
        ...this.data.address,
        phone: formatPhoneBlurValue(this.data.address && this.data.address.phone),
      },
    })
  },

  onLine1Input(e) {
    const value = e.detail.value
    const address = { ...this.data.address, line1: value }
    this.setData({ address })
    if (this._isPickingSuggestion) return
    this.debouncedSuggest(value)
  },

  onLine1Focus() {
    this.setData({ line1Focused: true })
  },

  onLine1Blur() {
    if (this._isPickingSuggestion) return
    this.setData({ line1Focused: false, suggestions: [] })
  },

  onSuggestionTouchStart() {
    this._isPickingSuggestion = true
  },

  debouncedSuggest(q) {
    const s = String(q || '').trim()
    if (this._timer) clearTimeout(this._timer)
    if (s.length < 3) {
      this.setData({ suggestions: [] })
      return
    }
    const reqId = (this._suggestReqId || 0) + 1
    this._suggestReqId = reqId
    this._timer = setTimeout(() => {
      this.fetchSuggestions(s, reqId)
    }, 250)
  },

  async fetchSuggestions(q, reqId) {
    const res = await suggestAddressDirect(q, 5)
    if (reqId !== this._suggestReqId) return
    if (this._isPickingSuggestion || !this.data.line1Focused) return
    const latestLine1 = String((this.data.address && this.data.address.line1) || '').trim()
    if (latestLine1 !== String(q || '').trim()) return
    if (!res.ok || !Array.isArray(res.suggestions)) {
      this.setData({ suggestions: [] })
      return
    }
    this.setData({ suggestions: res.suggestions })
  },

  pickSuggestion(e) {
    if (this._timer) clearTimeout(this._timer)
    this._timer = null
    this._suggestReqId = (this._suggestReqId || 0) + 1
    const idx = Number(e.currentTarget.dataset.i)
    const s = (this.data.suggestions || [])[idx]
    if (!s) {
      this._isPickingSuggestion = false
      return
    }
    const nextLine1 = line1FromSuggestion(s)
    const address = {
      ...this.data.address,
      line1: nextLine1,
      postalCode: s.postalCode || '',
      city: s.city || '',
    }
    this.setData({
      address,
      suggestions: [],
      line1Focused: false,
    })
    wx.hideKeyboard({
      complete: () => {
        this._isPickingSuggestion = false
      },
    })
  },

  onUnload() {
    if (this._timer) clearTimeout(this._timer)
    this._timer = null
    this._isPickingSuggestion = false
  },

  onSetDefault(e) {
    this.setData({ setDefault: !!e.detail.value })
  },

  async save() {
    if (this.data.saving) return
    const address = normalizeAddress(this.data.address)
    address.phone = normalizePhone(address.phone)
    if (!isFrAddressValid(address, { requirePhone: true, requireLabel: true })) {
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
    invalidateSnapshot()
    wx.showToast({ title: '已保存', icon: 'success' })
    wx.navigateBack()
  },
})
