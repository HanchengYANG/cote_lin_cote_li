const { call } = require('../../utils/api')
const { normalizePhone, isPhoneValid } = require('../../utils/phone')
const { invalidateSnapshot } = require('../../utils/app-snapshot')
const { createPage } = require('../../utils/create-page')
const { decorateOrderSummary } = require('../../utils/order-list')

function buildDefaultAddressDisplay(address) {
  if (!address) {
    return {
      title: '',
      detail: '',
    }
  }
  const title = String(address.label || '').trim() || '未命名地址'
  const parts = [address.line1, address.line2, address.postalCode, address.city, address.country]
    .map((x) => String(x || '').trim())
    .filter(Boolean)
  const phone = String(address.phone || '').trim()
  const detail = [
    parts.join(', '),
    phone ? `电话：${phone}` : '',
  ]
    .filter(Boolean)
    .join('  ')
  return { title, detail }
}

createPage({
  data: {
    from: '',
    pageTitle: '我的',
    loading: false,
    loadPhase: 'loading',
    nickname: '',
    profilePhone: '',
    savedNickname: '',
    savedProfilePhone: '',
    savingField: '',
    defaultAddressTitle: '',
    defaultAddressDetail: '',
    historyOrders: [],
    historyOrdersError: '',
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
    const [profileRes, ordersRes] = await Promise.all([
      call('customer', 'getMyProfile'),
      call('customer', 'listMyOrders'),
    ])
    this.setData({ loading: false })
    finishLoadPhase()
    if (!profileRes.ok || !profileRes.data || !profileRes.data.profile) {
      wx.showToast({ title: profileRes.message || '加载失败', icon: 'none' })
      return
    }
    const p = profileRes.data.profile
    const addresses = Array.isArray(p.addresses) ? p.addresses : []
    const current = addresses.find((x) => String(x.id || '') === String(p.defaultAddressId || '')) || addresses[0] || null
    const addressDisplay = buildDefaultAddressDisplay(current)
    let historyOrders = []
    let historyOrdersError = ''
    if (ordersRes && ordersRes.ok) {
      const raw = Array.isArray(ordersRes.data && ordersRes.data.orders) ? ordersRes.data.orders : []
      raw.sort((a, b) => {
        const ta = a && a.createdAt ? new Date(a.createdAt).getTime() : 0
        const tb = b && b.createdAt ? new Date(b.createdAt).getTime() : 0
        return tb - ta
      })
      historyOrders = raw.map(decorateOrderSummary).filter(Boolean).slice(0, 5)
    } else if (ordersRes) {
      historyOrdersError = String(ordersRes.message || '订单列表加载失败')
    }
    const nickname = String(p.nickname || '')
    const profilePhone = String(p.profilePhone || '')
    this.setData({
      nickname,
      profilePhone,
      savedNickname: nickname.trim(),
      savedProfilePhone: normalizePhone(profilePhone),
      defaultAddressTitle: addressDisplay.title,
      defaultAddressDetail: addressDisplay.detail,
      historyOrders,
      historyOrdersError,
    })
  },

  onNickInput(e) {
    this.setData({ nickname: e.detail.value })
  },

  onPhoneInput(e) {
    const profilePhone = normalizePhone(e && e.detail && e.detail.value)
    this.setData({ profilePhone })
  },

  onNickBlur() {
    this.saveProfileIfChanged('nickname')
  },

  onPhoneBlur() {
    this.saveProfileIfChanged('phone')
  },

  async saveProfileIfChanged(source) {
    if (this.data.savingField) {
      this._pendingAutoSave = true
      return
    }
    const nickname = String(this.data.nickname || '').trim()
    const profilePhone = normalizePhone(this.data.profilePhone)
    const savedNickname = String(this.data.savedNickname || '').trim()
    const savedProfilePhone = normalizePhone(this.data.savedProfilePhone)
    if (nickname === savedNickname && profilePhone === savedProfilePhone) return
    if (!nickname) {
      wx.showToast({ title: '请填写昵称', icon: 'none' })
      return
    }
    if (profilePhone && !isPhoneValid(profilePhone)) {
      wx.showToast({ title: '电话格式不正确', icon: 'none' })
      return
    }
    this.setData({ savingField: source || 'profile' })
    const res = await call('customer', 'updateMyNickname', { nickname, profilePhone })
    this.setData({ savingField: '' })
    if (!res.ok) {
      wx.showToast({ title: res.message || '保存失败', icon: 'none' })
      if (this._pendingAutoSave) {
        this._pendingAutoSave = false
        this.saveProfileIfChanged('retry')
      }
      return
    }
    invalidateSnapshot()
    this.setData({
      nickname,
      profilePhone,
      savedNickname: nickname,
      savedProfilePhone: profilePhone,
    })
    if (this._pendingAutoSave) {
      this._pendingAutoSave = false
      this.saveProfileIfChanged('retry')
    }
  },

  goAddressBook() {
    wx.navigateTo({ url: '/pages/address-book/index' })
  },

  goMyOrders() {
    wx.navigateTo({ url: '/pages/my-orders/index' })
  },

  goOrderDetail(e) {
    const id = String((e.currentTarget.dataset && e.currentTarget.dataset.id) || '').trim()
    if (!id) return
    wx.navigateTo({ url: `/pages/my-order-detail/index?orderId=${encodeURIComponent(id)}` })
  },
})
