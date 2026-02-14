const { call } = require('../../utils/api')
const { normalizePhone } = require('../../utils/phone')
const { normalizeFrAddress, isFrAddressValid } = require('../../utils/fr-address')

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

Page({
  data: {
    from: '',
    loading: false,
    saving: false,
    nickname: '',
    address: {
      label: '',
      line1: '',
      line2: '',
      postalCode: '',
      city: '',
      phone: '',
      country: 'FR',
    },
    suggestions: [],
  },

  async onLoad(query) {
    this.setData({ from: String((query && query.from) || '') })
    await this.reload()
  },

  async reload() {
    this.setData({ loading: true })
    const res = await call('customer', 'getMyProfile')
    this.setData({ loading: false })
    if (!res.ok || !res.data || !res.data.profile) {
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }
    const p = res.data.profile
    const addresses = Array.isArray(p.addresses) ? p.addresses : []
    const current = addresses.find((x) => x.id === p.defaultAddressId) || addresses[0] || null
    this.setData({
      nickname: String(p.nickname || ''),
      address: normalizeAddress(current),
    })
  },

  onNickInput(e) {
    this.setData({ nickname: e.detail.value })
  },

  pickWechatNickname() {
    wx.getUserProfile({
      desc: '用于订单称呼展示',
      success: (res) => {
        const nick = String((res && res.userInfo && res.userInfo.nickName) || '').trim()
        if (nick) this.setData({ nickname: nick })
      },
      fail: () => {},
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

  async save() {
    if (this.data.saving) return
    const nickname = String(this.data.nickname || '').trim()
    const address = normalizeAddress(this.data.address)
    address.phone = normalizePhone(address.phone)
    if (!nickname) {
      wx.showToast({ title: '请填写昵称', icon: 'none' })
      return
    }
    if (!isFrAddressValid(address, { requirePhone: true, requireLabel: true })) {
      wx.showToast({ title: '请填写完整地址和电话', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    const res = await call('customer', 'completeMyProfile', { nickname, address })
    this.setData({ saving: false })
    if (!res.ok) {
      wx.showToast({ title: res.message || '保存失败', icon: 'none' })
      return
    }
    wx.showToast({ title: '已保存', icon: 'success' })
    wx.navigateBack()
  },

  goAddressBook() {
    wx.navigateTo({ url: '/pages/address-book/index' })
  },
})
