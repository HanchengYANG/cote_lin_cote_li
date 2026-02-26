const { call } = require('../../../utils/api')
const { formatTime } = require('../../../utils/format')
const { formatPhoneDisplay } = require('../../../utils/phone')
const { decorateOrderSummary } = require('../../../utils/order-list')
const { createPage } = require('../../../utils/create-page')

function formatAddress(addr) {
  if (!addr) return ''
  return [addr.line1, addr.line2, addr.postalCode, addr.city, addr.country].filter(Boolean).join(', ')
}

function pickDefaultPhone(addresses, defaultAddressId) {
  const arr = Array.isArray(addresses) ? addresses : []
  const targetId = String(defaultAddressId || '').trim()
  const picked = arr.find((x) => String((x && x.id) || '').trim() === targetId) || arr[0] || null
  return formatPhoneDisplay(picked && picked.phone)
}

createPage({
  data: {
    customerOpenId: '',
    loading: false,
    customer: null,
    orders: [],
  },

  onLoad(query) {
    let customerOpenId = String((query && query.customerOpenId) || '')
    try {
      customerOpenId = decodeURIComponent(customerOpenId)
    } catch (err) {}
    customerOpenId = customerOpenId.trim()
    this.setData({ customerOpenId })
    this.reload()
  },

  async reload() {
    if (!this.data.customerOpenId) {
      wx.showToast({ title: '缺少客人ID', icon: 'none' })
      return
    }
    this.setData({ loading: true })
    const res = await call('admin', 'getCustomerDetail', { customerOpenId: this.data.customerOpenId })
    this.setData({ loading: false })
    if (!res.ok) {
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }

    const rawCustomer = (res.data && res.data.customer) || null
    const rawOrders = Array.isArray(res.data && res.data.orders) ? res.data.orders : []
    const addresses = Array.isArray(rawCustomer && rawCustomer.addresses) ? rawCustomer.addresses : []
    const defaultAddressId = String((rawCustomer && rawCustomer.defaultAddressId) || '').trim()

    const defaultAddress =
      addresses.find((x) => String((x && x.id) || '').trim() === defaultAddressId) ||
      addresses[0] ||
      null

    const customer = rawCustomer
      ? {
          ...rawCustomer,
          nicknameText: String(rawCustomer.nickname || '').trim() || '未设置昵称',
          openIdText: this.data.customerOpenId,
          defaultPhoneText: pickDefaultPhone(addresses, defaultAddressId) || '-',
          defaultAddressText: formatAddress(defaultAddress) || '-',
          addresses: addresses.map((a) => ({
            ...a,
            phone: formatPhoneDisplay(a && a.phone),
            fullText: formatAddress(a),
          })),
        }
      : null

    const orders = rawOrders.map((o) => {
      const decorated = decorateOrderSummary(o)
      return {
        ...decorated,
        createdAtText: formatTime(o && o.createdAt),
      }
    })

    this.setData({ customer, orders })
  },

  goOrderDetail(e) {
    const orderId = String((e.currentTarget.dataset && e.currentTarget.dataset.id) || '').trim()
    if (!orderId) return
    wx.navigateTo({ url: `/pages/admin/order-detail/index?orderId=${encodeURIComponent(orderId)}` })
  },
})
