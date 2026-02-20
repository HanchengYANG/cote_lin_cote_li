Component({
  properties: {
    ready: {
      type: Boolean,
      value: true,
    },
    error: {
      type: String,
      value: '',
    },
  },

  data: {
    navTopPx: 44,
  },

  lifetimes: {
    attached() {
      const device = (wx.getDeviceInfo && wx.getDeviceInfo()) || wx.getSystemInfoSync()
      const win = (wx.getWindowInfo && wx.getWindowInfo()) || wx.getSystemInfoSync()
      const platform = device && device.platform ? device.platform : ''
      const safeTop = (win && win.safeArea && Number(win.safeArea.top)) || 0
      const navHeight = platform === 'android' || platform === 'devtools' ? 48 : 44
      this.setData({ navTopPx: safeTop + navHeight })
    },
  },

  methods: {
    noop() {},

    onRetryTap() {
      this.triggerEvent('retry')
    },
  },
})
