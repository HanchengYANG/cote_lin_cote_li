Page({
  data: {
    orderId: '',
    tip: '',
  },

  onLoad(query) {
    const orderId = (query && query.orderId) || ''
    this.setData({
      orderId,
      tip: '配送订单将在店主填写的时间段内安排送达；自取订单请按店主安排到店自取。',
    })
  },

  goOrders() {
    wx.navigateTo({ url: '/pages/my-orders/index' })
  },

  goMenu() {
    wx.reLaunch({ url: '/pages/index/index' })
  },
})

