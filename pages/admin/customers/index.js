const { call } = require('../../../utils/api')
const { formatTime } = require('../../../utils/format')
const { createPage } = require('../../../utils/create-page')

function asText(v, fallback = '-') {
  const s = String(v || '').trim()
  return s || fallback
}

createPage({
  data: {
    loading: false,
    customers: [],
  },

  onShow() {
    this.reload()
  },

  async reload() {
    this.setData({ loading: true })
    const res = await call('admin', 'listCustomers')
    this.setData({ loading: false })
    if (!res.ok) {
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }
    const rows = Array.isArray(res.data && res.data.customers) ? res.data.customers : []
    const customers = rows.map((it) => ({
      ...it,
      nicknameText: asText(it.nickname, '未设置昵称'),
      phoneText: asText(it.defaultPhone),
      openIdText: asText(it.customerOpenId),
      lastOrderAtText: it.lastOrderAt ? formatTime(it.lastOrderAt) : '-',
      orderCountText: Number(it.orderCount || 0),
      addressCountText: Number(it.addressCount || 0),
    }))
    this.setData({ customers })
  },

  goDetail(e) {
    const customerOpenId = String((e.currentTarget.dataset && e.currentTarget.dataset.id) || '').trim()
    if (!customerOpenId) return
    wx.navigateTo({
      url: `/pages/admin/customer-detail/index?customerOpenId=${encodeURIComponent(customerOpenId)}`,
    })
  },
})
