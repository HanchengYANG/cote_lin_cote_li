const { call } = require('../../../utils/api')
const { centToEuro, euroToCent } = require('../../../utils/format')
const { getSession } = require('../../../utils/session')

function clampImages(arr) {
  const out = Array.isArray(arr) ? arr.filter(Boolean) : []
  return out.slice(0, 10)
}

function normalizeImageIds(input) {
  return Array.isArray(input) ? clampImages(input.map((x) => String(x || '').trim())) : []
}

function normalizeImageUrls(input) {
  const arr = Array.isArray(input) ? input : []
  return clampImages(arr.map((x) => String(x || '').trim()))
}

function chooseImages(remain) {
  const chooseImage = () =>
    new Promise((resolve, reject) => {
      wx.chooseImage({
        count: remain,
        sizeType: ['compressed'],
        sourceType: ['album', 'camera'],
        success: resolve,
        fail: reject,
      })
    })

  return chooseImage()
}

Page({
  data: {
    dishId: '',
    name: '',
    priceEuro: '',
    isActive: true,
    images: [], // fileIDs
    imageUrls: [], // temp urls for preview
    descMd: '',
    saving: false,
    uploading: false,
    choosing: false,
  },

  async onLoad(query) {
    const dishId = (query && query.dishId) || ''
    this.setData({ dishId })
    if (!dishId) return
    const res = await call('admin', 'getDish', { dishId })
    if (!res.ok) {
      wx.showToast({ title: res.message || '加载失败', icon: 'none' })
      return
    }
    const d = res.data.dish
    const imageIds = normalizeImageIds(d.images)
    const imageUrls = normalizeImageUrls(d.imageUrls || [])
    this.setData({
      name: d.name || '',
      priceEuro: centToEuro(d.priceCents || 0),
      isActive: !!d.isActive,
      images: imageIds,
      imageUrls,
      descMd: d.descMd || '',
    })
  },

  onName(e) {
    this.setData({ name: e.detail.value })
  },

  onPrice(e) {
    this.setData({ priceEuro: e.detail.value })
  },

  onActive(e) {
    this.setData({ isActive: !!e.detail.value })
  },

  onDesc(e) {
    this.setData({ descMd: e.detail.value })
  },

  async addImages() {
    if (!wx.cloud) {
      wx.showToast({ title: '请先启用云开发', icon: 'none' })
      return
    }
    if (this.data.uploading || this.data.choosing) return
    if ((this.data.images || []).length >= 10) {
      wx.showToast({ title: '最多 10 张', icon: 'none' })
      return
    }
    const remain = 10 - (this.data.images || []).length
    // Quick feedback so user knows the tap is handled.
    try {
      wx.vibrateShort({ type: 'light' })
    } catch (e) {
      // ignore
    }
    wx.showToast({ title: '打开相册/相机...', icon: 'none', duration: 800 })

    let chooseRes = null
    this.setData({ choosing: true })
    try {
      chooseRes = await chooseImages(remain)
    } catch (err) {
      const msg = (err && (err.errMsg || err.message)) || ''
      if (msg && msg.includes('cancel')) return
      if (msg && /timeout|timed out|超时/i.test(msg)) {
        wx.showToast({ title: '系统选择器无响应，请重试', icon: 'none' })
      } else {
        wx.showToast({ title: msg || '选择图片失败', icon: 'none' })
      }
      return
    } finally {
      this.setData({ choosing: false })
    }

    const safeChooseRes = chooseRes || {}
    const files = (safeChooseRes.tempFiles || [])
      .map((f) => (f && (f.tempFilePath || f.path)) || '')
      .filter(Boolean)
    if (files.length === 0 && Array.isArray(safeChooseRes.tempFilePaths)) {
      files.push(...safeChooseRes.tempFilePaths.filter(Boolean))
    }
    if (files.length === 0) return

    const prevImages = [...(this.data.images || [])]
    const prevImageUrls = [...(this.data.imageUrls || [])]
    const nextImageUrls = clampImages([...prevImageUrls, ...files])

    this.setData({ uploading: true, imageUrls: nextImageUrls })
    wx.showLoading({ title: '上传中...' })
    try {
      const sess = await getSession()
      const openId = sess.openId || 'anon'
      const ts = Date.now()
      const uploaded = []
      for (let i = 0; i < files.length; i++) {
        const filePath = files[i]
        const cloudPath = `dish-images/${openId}/${ts}-${i}.jpg`
        const up = await wx.cloud.uploadFile({ cloudPath, filePath })
        uploaded.push(up.fileID)
      }
      const images = clampImages([...prevImages, ...uploaded])
      this.setData({ images, imageUrls: nextImageUrls })
    } catch (err) {
      this.setData({ imageUrls: prevImageUrls })
      wx.showToast({ title: (err && err.errMsg) || '上传失败', icon: 'none' })
    } finally {
      wx.hideLoading()
      this.setData({ uploading: false })
    }
  },

  removeImg(e) {
    const i = Number(e.currentTarget.dataset.i)
    const images = [...(this.data.images || [])]
    const imageUrls = [...(this.data.imageUrls || [])]
    images.splice(i, 1)
    imageUrls.splice(i, 1)
    this.setData({ images, imageUrls })
  },

  moveUp(e) {
    const i = Number(e.currentTarget.dataset.i)
    if (i <= 0) return
    const images = [...(this.data.images || [])]
    const imageUrls = [...(this.data.imageUrls || [])]
    ;[images[i - 1], images[i]] = [images[i], images[i - 1]]
    ;[imageUrls[i - 1], imageUrls[i]] = [imageUrls[i], imageUrls[i - 1]]
    this.setData({ images, imageUrls })
  },

  moveDown(e) {
    const i = Number(e.currentTarget.dataset.i)
    const images = [...(this.data.images || [])]
    const imageUrls = [...(this.data.imageUrls || [])]
    if (i < 0 || i >= images.length - 1) return
    ;[images[i + 1], images[i]] = [images[i], images[i + 1]]
    ;[imageUrls[i + 1], imageUrls[i]] = [imageUrls[i], imageUrls[i + 1]]
    this.setData({ images, imageUrls })
  },

  async save() {
    const name = String(this.data.name || '').trim()
    const priceCents = euroToCent(this.data.priceEuro)
    if (!name) {
      wx.showToast({ title: '请填写名称', icon: 'none' })
      return
    }
    if (priceCents <= 0) {
      wx.showToast({ title: '请填写价格', icon: 'none' })
      return
    }
    this.setData({ saving: true })
    const res = await call('admin', 'upsertDish', {
      dishId: this.data.dishId || null,
      name,
      priceCents,
      isActive: !!this.data.isActive,
      images: clampImages(this.data.images || []),
      descMd: String(this.data.descMd || ''),
    })
    this.setData({ saving: false })
    if (!res.ok) {
      wx.showToast({ title: res.message || '保存失败', icon: 'none' })
      return
    }
    const deleteError = res.data && res.data.deleteError
    if (deleteError) {
      wx.showToast({ title: '已保存，旧图清理失败', icon: 'none' })
    } else {
      wx.showToast({ title: '已保存', icon: 'success' })
    }
    wx.navigateBack()
  },
})
