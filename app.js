// app.js
App({
  onLaunch() {
    if (wx.cloud) {
      // Use the devtools-selected default env. You can set env explicitly later.
      wx.cloud.init({
        traceUser: true,
      })
    } else {
      // eslint-disable-next-line no-console
      console.warn('wx.cloud is not available. Enable CloudBase in WeChat devtools.')
    }
  },
})
