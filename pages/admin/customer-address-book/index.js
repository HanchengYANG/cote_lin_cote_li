const { call } = require('../../../utils/api')
const { invalidateSnapshot } = require('../../../utils/app-snapshot')
const { formatPhoneDisplay } = require('../../../utils/phone')
const { createPage } = require('../../../utils/create-page')

function normalizeCustomerOpenId(input) {
  let value = String(input || '')
  try {
    value = decodeURIComponent(value)
  } catch (err) {}
  return value.trim()
}

function formatAddressDetail(a) {
  return [a.line1, a.line2, a.postalCode, a.city, a.country].filter(Boolean).join(', ')
}

createPage({
  data: {
    customerOpenId: '',
    loading: false,
    loadPhase: 'loading',
    customer: null,
    addresses: [],
  },

  onLoad(query) {
    const customerOpenId = normalizeCustomerOpenId(query && query.customerOpenId)
    this.setData({ customerOpenId })
  },

  onShow() {
    this.reload()
  },

  async reload() {
    const customerOpenId = String(this.data.customerOpenId || '').trim()
    if (!customerOpenId) {
      wx.showToast({ title: '缺少客人ID', icon: 'none' })
      return
    }
    this.setData({ loading: true })
    const finishLoadPhase = () => {
      if (this.data.loadPhase !== 'ready') this.setData({ loadPhase: 'ready' })
    }
    if (this.data.loadPhase !== 'ready') this.setData({ loadPhase: 'loading' })
    const res = await call('admin', 'getCustomerAddressBook', { customerOpenId })
    this.setData({ loading: false })
    finishLoadPhase()
    if (!res.ok) {
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }
    const customer = (res.data && res.data.customer) || null
    const addresses = Array.isArray(res.data && res.data.addresses) ? res.data.addresses : []
    const defaultAddressId = String((customer && customer.defaultAddressId) || '').trim()
    const decoratedAddresses = addresses.map((a) => ({
      ...a,
      title: String((a && a.label) || '').trim() || `${String((a && a.line1) || '').trim()} ${String((a && a.city) || '').trim()}`.trim(),
      detail: formatAddressDetail(a),
      phoneText: formatPhoneDisplay(a && a.phone),
      isDefault: String((a && a.id) || '').trim() === defaultAddressId,
    }))
    this.setData({
      customer: customer
        ? {
            ...customer,
            nicknameText: String(customer.nickname || '').trim() || '未设置昵称',
            openIdText: customerOpenId,
          }
        : null,
      addresses: decoratedAddresses,
    })
  },

  goAdd() {
    const customerOpenId = String(this.data.customerOpenId || '').trim()
    if (!customerOpenId) return
    wx.navigateTo({
      url: `/pages/admin/customer-address-edit/index?customerOpenId=${encodeURIComponent(customerOpenId)}`,
    })
  },

  goEdit(e) {
    const customerOpenId = String(this.data.customerOpenId || '').trim()
    const addressId = String((e.currentTarget.dataset && e.currentTarget.dataset.id) || '').trim()
    if (!customerOpenId || !addressId) return
    wx.navigateTo({
      url: `/pages/admin/customer-address-edit/index?customerOpenId=${encodeURIComponent(customerOpenId)}&addressId=${encodeURIComponent(addressId)}`,
    })
  },

  async setDefault(e) {
    const customerOpenId = String(this.data.customerOpenId || '').trim()
    const addressId = String((e.currentTarget.dataset && e.currentTarget.dataset.id) || '').trim()
    if (!customerOpenId || !addressId) return
    const res = await call('admin', 'setCustomerDefaultAddress', { customerOpenId, addressId })
    if (!res.ok) {
      wx.showToast({ title: res.message || '设置失败', icon: 'none' })
      return
    }
    invalidateSnapshot()
    wx.showToast({ title: '已设为默认', icon: 'success' })
    await this.reload()
  },

  async remove(e) {
    const customerOpenId = String(this.data.customerOpenId || '').trim()
    const addressId = String((e.currentTarget.dataset && e.currentTarget.dataset.id) || '').trim()
    if (!customerOpenId || !addressId) return
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
    const res = await call('admin', 'deleteCustomerAddress', { customerOpenId, addressId })
    if (!res.ok) {
      wx.showToast({ title: res.message || '删除失败', icon: 'none' })
      return
    }
    invalidateSnapshot()
    wx.showToast({ title: '已删除', icon: 'success' })
    await this.reload()
  },
})
