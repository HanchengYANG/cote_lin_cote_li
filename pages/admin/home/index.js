const { call } = require('../../../utils/api')
const { getSession } = require('../../../utils/session')
const { getSnapshot, invalidateSnapshot } = require('../../../utils/app-snapshot')
const { createPage } = require('../../../utils/create-page')

function saleStatusText(status) {
  const v = String(status || '').trim()
  if (v === 'DRAFT') return '草稿'
  if (v === 'OPEN') return '开单中'
  if (v === 'CLOSED') return '已截单（生产中）'
  if (v === 'FULFILLING') return '配送中'
  if (v === 'COMPLETED') return '完成'
  return v || '未知'
}

const FORCE_STATUS_OPTIONS = [
  { label: '改为 开单中（OPEN）', value: 'OPEN' },
  { label: '改为 已截单（CLOSED）', value: 'CLOSED' },
  { label: '改为 配送中（FULFILLING）', value: 'FULFILLING' },
  { label: '改为 完成（COMPLETED）', value: 'COMPLETED' },
  { label: '改为 草稿（DRAFT）', value: 'DRAFT' },
]

createPage({
  data: {
    refresherTriggered: false,
    authKnown: false,
    isAdmin: false,
    myOpenId: '',
    activeSale: null,
    stats: { orderCount: 0 },
    activeSaleRevenueCents: 0,
    activeSaleRevenueEuro: '0.00',
    activeSaleDishStats: [],
    activeSaleOpsSummary: null,
    canCompleteActiveSale: false,
    activeSaleIncompleteReason: null,
    completingActiveSale: false,
    openSalesListCollapsed: true,
    closedProductionItemsCollapsed: true,
    fulfillingProductionItemsCollapsed: true,
    saleKnown: false,
  },

  onLoad() {
    this.hydrateFromSnapshot()
    this.reload({ silent: true })
  },

  hydrateFromSnapshot() {
    const snapshot = getSnapshot()
    const sale = snapshot && snapshot.sale
    if (!sale) return
    const saleStatus = String((sale && sale.status) || '').trim()
    const isCurrentSale = saleStatus === 'OPEN' || saleStatus === 'CLOSED' || saleStatus === 'FULFILLING'
    this.setData({
      activeSale: isCurrentSale
        ? {
            _id: String(sale.saleId || sale._id || ''),
            status: saleStatus,
            statusText: saleStatusText(saleStatus),
            deliveryTimeSlotLabel: String(sale.deliveryTimeSlotLabel || ''),
          }
        : null,
      activeSaleDishStats: [],
      activeSaleRevenueCents: 0,
      activeSaleRevenueEuro: '0.00',
      activeSaleOpsSummary: null,
      canCompleteActiveSale: false,
      activeSaleIncompleteReason: null,
      saleKnown: true,
    })
  },

  async reload(options = {}) {
    const silent = !!options.silent
    if (!silent) this.setData({ refresherTriggered: true })
    try {
      const sess = await getSession()
      const isAdmin = !!sess.isAdmin
      const myOpenId = sess.openId || ''
      this.setData({ authKnown: true, isAdmin, myOpenId })
      if (!isAdmin) {
        this.setData({
          activeSale: null,
          stats: { orderCount: 0 },
          activeSaleDishStats: [],
          activeSaleRevenueCents: 0,
          activeSaleRevenueEuro: '0.00',
          activeSaleOpsSummary: null,
          canCompleteActiveSale: false,
          activeSaleIncompleteReason: null,
          saleKnown: true,
        })
        return
      }

      const dashRes = await call('admin', 'getDashboard')
      if (dashRes.ok) {
        const activeSaleRaw = dashRes.data.activeSale || null
        this.setData({
          activeSale: activeSaleRaw
            ? {
                ...activeSaleRaw,
                statusText: saleStatusText(activeSaleRaw.status),
              }
            : null,
          stats: dashRes.data.stats || { orderCount: 0 },
          activeSaleRevenueCents: Number(dashRes.data.activeSaleRevenueCents || 0),
          activeSaleRevenueEuro: String(dashRes.data.activeSaleRevenueEuro || '0.00'),
          activeSaleDishStats: Array.isArray(dashRes.data.activeSaleDishStats) ? dashRes.data.activeSaleDishStats : [],
          activeSaleOpsSummary: dashRes.data.activeSaleOpsSummary || null,
          canCompleteActiveSale: !!dashRes.data.canCompleteActiveSale,
          activeSaleIncompleteReason: dashRes.data.activeSaleIncompleteReason || null,
          saleKnown: true,
        })
      } else if (!this.data.saleKnown) {
        this.setData({ saleKnown: true })
      }
    } finally {
      if (!silent) this.setData({ refresherTriggered: false })
    }
  },

  onPullDownRefresh() {
    this.reload().finally(() => {
      wx.stopPullDownRefresh()
    })
  },

  copyOpenId() {
    wx.setClipboardData({ data: this.data.myOpenId })
  },

  toggleOpenSalesListCollapsed() {
    this.setData({ openSalesListCollapsed: !this.data.openSalesListCollapsed })
  },

  toggleClosedProductionItemsCollapsed() {
    this.setData({ closedProductionItemsCollapsed: !this.data.closedProductionItemsCollapsed })
  },

  toggleFulfillingProductionItemsCollapsed() {
    this.setData({ fulfillingProductionItemsCollapsed: !this.data.fulfillingProductionItemsCollapsed })
  },

  goDishes() {
    wx.navigateTo({ url: '/pages/admin/dishes/index' })
  },

  goSaleDraft() {
    wx.navigateTo({ url: '/pages/admin/sale-draft/index' })
  },

  goOrders() {
    wx.navigateTo({ url: '/pages/admin/orders/index' })
  },

  goCustomers() {
    wx.navigateTo({ url: '/pages/admin/customers/index' })
  },

  goActiveSaleEdit() {
    wx.navigateTo({ url: '/pages/admin/sale-active-edit/index' })
  },

  goSaleReview() {
    wx.navigateTo({ url: '/pages/admin/export/index' })
  },

  goFulfillmentPrep() {
    wx.navigateTo({ url: '/pages/admin/fulfillment-prep/index' })
  },

  goFulfillmentRun() {
    wx.navigateTo({ url: '/pages/admin/fulfillment-run/index' })
  },

  goPickupRun() {
    wx.navigateTo({ url: '/pages/admin/pickup-run/index' })
  },

  goProduction() {
    wx.navigateTo({ url: '/pages/admin/production/index' })
  },

  goDeliveryRules() {
    wx.navigateTo({ url: '/pages/admin/delivery-rules/index' })
  },

  debugForceSetSaleStatus() {
    const sale = this.data.activeSale
    if (!sale || !sale._id) {
      wx.showToast({ title: '当前没有可修改的开单', icon: 'none' })
      return
    }
    wx.showActionSheet({
      itemList: FORCE_STATUS_OPTIONS.map((x) => x.label),
      success: async (res) => {
        const idx = Number(res && res.tapIndex)
        const picked = FORCE_STATUS_OPTIONS[idx]
        if (!picked) return
        const modalRes = await new Promise((resolve) => {
          wx.showModal({
            title: '调试修改开单状态',
            content: `将当前开单状态强制改为：${saleStatusText(picked.value)}（不做业务校验）`,
            success: resolve,
            fail: () => resolve({ confirm: false }),
          })
        })
        if (!modalRes.confirm) return
        const callRes = await call('admin', 'forceSetCurrentSaleStatus', {
          saleId: sale._id,
          status: picked.value,
        })
        if (!callRes.ok) {
          wx.showToast({ title: callRes.message || '修改失败', icon: 'none' })
          return
        }
        invalidateSnapshot()
        wx.showToast({ title: `已改为${saleStatusText(picked.value)}`, icon: 'success' })
        await this.reload({ silent: true })
      },
    })
  },

  async closeSale() {
    const sale = this.data.activeSale
    if (!sale) return
    wx.showModal({
      title: '确认截单',
      content: '截单后顾客无法再下单。',
      success: async (r) => {
        if (!r.confirm) return
        const res = await call('admin', 'closeSale', { saleId: sale._id })
        if (!res.ok) {
          wx.showToast({ title: res.message || '截单失败', icon: 'none' })
          return
        }
        invalidateSnapshot()
        wx.showToast({ title: '已截单', icon: 'success' })
        this.reload()
      },
    })
  },

  async completeActiveSale() {
    const sale = this.data.activeSale
    if (!sale || String(sale.status || '') !== 'FULFILLING' || this.data.completingActiveSale) return
    const modalRes = await new Promise((resolve) => {
      wx.showModal({
        title: '完成本次开单',
        content: '仅当所有有效订单（配送+自取）都已交付且已收款时才能完成。',
        success: resolve,
        fail: () => resolve({ confirm: false }),
      })
    })
    if (!modalRes.confirm) return
    this.setData({ completingActiveSale: true })
    const res = await call('admin', 'completeSaleFulfillment', { saleId: sale._id })
    this.setData({ completingActiveSale: false })
    if (!res.ok) {
      const detail = res.detail || {}
      if (res.code === 'SALE_NOT_READY_TO_COMPLETE') {
        wx.showToast({
          title: `未完成：未交付${Number(detail.undeliveredCount || 0)} / 未收款${Number(detail.unpaidCount || 0)}`,
          icon: 'none',
        })
      } else {
        wx.showToast({ title: res.message || '完成失败', icon: 'none' })
      }
      await this.reload({ silent: true })
      return
    }
    invalidateSnapshot()
    wx.showToast({ title: '开单已完成', icon: 'success' })
    await this.reload({ silent: true })
  },
})
