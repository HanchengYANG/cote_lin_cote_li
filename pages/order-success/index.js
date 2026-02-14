const { call } = require('../../utils/api')

Page({
  data: {
    orderId: '',
    tip: '',
  },

  async onLoad(query) {
    const orderId = (query && query.orderId) || ''
    this.setData({
      orderId,
      tip: '配送订单将在店主填写的时间段内安排送达；自取订单请按店主安排到店自取。',
    })
    if (!orderId) return
    const res = await call('customer', 'getMyOrderDetail', { orderId })
    if (!res.ok || !res.data || !res.data.order) return
    const order = res.data.order
    if (order.status === 'PENDING_REVIEW') {
      this.setData({
        tip: '你的订单已提交为“待店主确认”，暂未占用库存。店主确认后会自动生效。',
      })
    }
  },

  goOrders() {
    wx.navigateTo({ url: '/pages/my-orders/index' })
  },

  goMenu() {
    wx.reLaunch({ url: '/pages/index/index' })
  },
})
