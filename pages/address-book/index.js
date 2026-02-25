const { call } = require('../../utils/api')
const { invalidateSnapshot } = require('../../utils/app-snapshot')
const { createPage } = require('../../utils/create-page')

createPage({
  data: {
    loading: false,
    loadPhase: 'loading',
    selectMode: false,
    selectedAddressId: '',
    profile: null,
    addresses: [],
  },

  onLoad(query) {
    this.setData({
      selectMode: String((query && query.select) || '') === '1',
      selectedAddressId: String((query && query.selectedAddressId) || ''),
    })
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
    const arr = Array.isArray(p.addresses) ? p.addresses : []
    const addresses = arr.map((a) => ({
      ...a,
      title: String(a.label || '').trim() || `${String(a.line1 || '').trim()} ${String(a.city || '').trim()}`.trim(),
      detail: [a.line1, a.line2, a.postalCode, a.city, a.country].filter(Boolean).join(', '),
      phoneText: String(a.phone || '').trim(),
      isDefault: String(p.defaultAddressId || '') === String(a.id || ''),
      isPicked: String(this.data.selectedAddressId || '') === String(a.id || ''),
    }))
    this.setData({ profile: p, addresses })
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/address-edit/index' })
  },

  goEdit(e) {
    const id = String(e.currentTarget.dataset.id || '')
    if (!id) return
    wx.navigateTo({ url: `/pages/address-edit/index?addressId=${encodeURIComponent(id)}` })
  },

  choose(e) {
    if (!this.data.selectMode) return
    const id = String(e.currentTarget.dataset.id || '')
    if (!id) return
    wx.setStorageSync('checkout_selected_address_id', id)
    wx.navigateBack()
  },

  async setDefault(e) {
    const id = String(e.currentTarget.dataset.id || '')
    if (!id) return
    const res = await call('customer', 'setDefaultAddress', { addressId: id })
    if (!res.ok) {
      wx.showToast({ title: res.message || '设置失败', icon: 'none' })
      return
    }
    invalidateSnapshot()
    wx.showToast({ title: '已设为默认', icon: 'success' })
    await this.reload()
  },

  async remove(e) {
    const id = String(e.currentTarget.dataset.id || '')
    if (!id) return
    const modalRes = await new Promise((resolve) => {
      wx.showModal({
        title: '删除地址',
        content: '确认删除该地址吗？',
        confirmColor: '#d93025',
        success: resolve,
        fail: () => resolve({ confirm: false }),
      })
    })
    if (!modalRes.confirm) return
    const res = await call('customer', 'deleteMyAddress', { addressId: id })
    if (!res.ok) {
      wx.showToast({ title: res.message || '删除失败', icon: 'none' })
      return
    }
    invalidateSnapshot()
    wx.showToast({ title: '已删除', icon: 'success' })
    await this.reload()
  },
})
