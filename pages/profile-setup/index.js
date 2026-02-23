const { call } = require('../../utils/api')
const { normalizePhone, isPhoneValid } = require('../../utils/phone')
const { invalidateSnapshot } = require('../../utils/app-snapshot')
const { createPage } = require('../../utils/create-page')

function buildDefaultAddressSummary(address) {
  if (!address) return '未设置默认地址'
  const label = String(address.label || '').trim() || '未命名地址'
  const city = String(address.city || '').trim() || '-'
  const phone = String(address.phone || '').trim() || '-'
  return `${label} · ${city} · ${phone}`
}

createPage({
  data: {
    from: '',
    pageTitle: '我的',
    loading: false,
    loadPhase: 'loading',
    saving: false,
    nickname: '',
    profilePhone: '',
    defaultAddressSummary: '未设置默认地址',
  },

  onLoad(query) {
    const from = String((query && query.from) || '')
    const pageTitle = from === 'checkout' ? '完善资料' : '我的'
    this.setData({ from, pageTitle })
  },

  onShow() {
    this.reload()
  },

  async reload() {
    this.setData({ loading: true })
    const finishLoadPhase = () => {
      if (this.data.loadPhase !== 'ready') {
        this.setData({ loadPhase: 'ready' })
      }
    }
    if (this.data.loadPhase !== 'ready') this.setData({ loadPhase: 'loading' })
    const res = await call('customer', 'getMyProfile')
    this.setData({ loading: false })
    finishLoadPhase()
    if (!res.ok || !res.data || !res.data.profile) {
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }
    const p = res.data.profile
    const addresses = Array.isArray(p.addresses) ? p.addresses : []
    const current = addresses.find((x) => String(x.id || '') === String(p.defaultAddressId || '')) || addresses[0] || null
    this.setData({
      nickname: String(p.nickname || ''),
      profilePhone: String(p.profilePhone || ''),
      defaultAddressSummary: buildDefaultAddressSummary(current),
    })
  },

  onNickInput(e) {
    this.setData({ nickname: e.detail.value })
  },

  onPhoneInput(e) {
    const profilePhone = normalizePhone(e && e.detail && e.detail.value)
    this.setData({ profilePhone })
  },

  async save() {
    if (this.data.saving) return
    const nickname = String(this.data.nickname || '').trim()
    const profilePhone = normalizePhone(this.data.profilePhone)
    if (!nickname) {
      wx.showToast({ title: '请填写昵称', icon: 'none' })
      return
    }
    if (profilePhone && !isPhoneValid(profilePhone)) {
      wx.showToast({ title: '电话格式不正确', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    const res = await call('customer', 'updateMyNickname', { nickname, profilePhone })
    this.setData({ saving: false })
    if (!res.ok) {
      wx.showToast({ title: res.message || '保存失败', icon: 'none' })
      return
    }
    invalidateSnapshot()
    wx.showToast({ title: '已保存', icon: 'success' })
    wx.navigateBack()
  },

  goAddressBook() {
    wx.navigateTo({ url: '/pages/address-book/index' })
  },

  goMyOrders() {
    wx.navigateTo({ url: '/pages/my-orders/index' })
  },
})
