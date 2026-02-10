function wxp(fn, args = {}) {
  return new Promise((resolve, reject) => {
    fn({
      ...args,
      success: resolve,
      fail: reject,
    })
  })
}

module.exports = {
  wxp,
}

