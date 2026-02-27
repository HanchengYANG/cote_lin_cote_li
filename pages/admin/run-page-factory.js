const { call } = require('../../utils/api')
const { geocodeAddressDirect } = require('../../utils/address-geocode')
const { showErrorDialog } = require('../../utils/error-feedback')
const { formatTime, centToEuro } = require('../../utils/format')
const { formatPhoneDisplay, normalizePhone } = require('../../utils/phone')
const { createPage } = require('../../utils/create-page')

function saleStatusText(status) {
  const v = String(status || '').trim()
  if (v === 'DRAFT') return '草稿'
  if (v === 'OPEN') return '开单中'
  if (v === 'CLOSED') return '已截单'
  if (v === 'FULFILLING') return '配送中'
  if (v === 'COMPLETED') return '完成'
  return v || '未知'
}

function buildSaleLabel(sale) {
  if (!sale) return '未知开单'
  const status = saleStatusText(sale.status)
  const ts = formatTime(sale.createdAt)
  return `${status}${ts ? ` ${ts}` : ''}`
}

function pickSaleIndex(options, prefSaleId, currentValue, preferredStatuses) {
  if (!Array.isArray(options) || options.length === 0) return 0
  if (prefSaleId) {
    const idx = options.findIndex((o) => o.value === prefSaleId)
    if (idx >= 0) return idx
  }
  if (currentValue) {
    const idx = options.findIndex((o) => o.value === currentValue)
    if (idx >= 0) return idx
  }
  const priorities = Array.isArray(preferredStatuses) ? preferredStatuses : []
  for (const status of priorities) {
    const idx = options.findIndex((o) => o.status === status)
    if (idx >= 0) return idx
  }
  return 0
}

function paymentMethodLabel(method) {
  const v = String(method || '').trim()
  if (v === 'wechat_transfer') return '微信转账'
  if (v === 'alipay_transfer') return '支付宝转账'
  return '现金'
}

function paidStatusLabel(status) {
  return String(status || '') === 'PAID' ? '已收款' : '未收款'
}

function handoffStatusLabel(status) {
  return String(status || '') === 'DELIVERED' ? '已交付' : '未交付'
}

function decorateRunOrder(order) {
  const o = order || {}
  const isPickup = String(o.fulfillmentType || '') === 'pickup'
  const amountCents = Number(o.totals && o.totals.amountCents) || 0
  const phoneRaw = normalizePhone(o.contact && o.contact.phone)
  const addressRaw = String(o.addressText || '').trim()
  return {
    ...o,
    customerNameText: String(o.customerNickname || '').trim() || '匿名客户',
    amountEuro: centToEuro(amountCents),
    phoneRaw,
    phoneText: formatPhoneDisplay(phoneRaw) || '-',
    fulfillmentText: isPickup ? '自取' : '配送',
    addressRaw,
    addressDisplay: isPickup ? '自取' : String(o.addressText || '').trim() || '地址未填写',
    paymentMethodText: paymentMethodLabel(o.payment && o.payment.method),
    paidStatusText: paidStatusLabel(o.payment && o.payment.paidStatus),
    handoffStatusText: handoffStatusLabel(o.handoffStatus),
    isPaid: String(o.payment && o.payment.paidStatus) === 'PAID',
    isDelivered: String(o.handoffStatus || '') === 'DELIVERED',
    canGoogleNavigate: !isPickup && !!addressRaw,
  }
}

function splitOrdersByDelivered(orders) {
  const arr = Array.isArray(orders) ? orders : []
  const pending = []
  const delivered = []
  for (const item of arr) {
    if (item && item.isDelivered) {
      delivered.push(item)
      continue
    }
    pending.push(item)
  }
  return { pending, delivered }
}

function readDatasetString(e, key) {
  const dataset = (e && e.currentTarget && e.currentTarget.dataset) || {}
  return String(dataset[key] || '').trim()
}

function findOrderById(orders, orderId) {
  if (!orderId) return null
  const list = Array.isArray(orders) ? orders : []
  return list.find((it) => String((it && it._id) || '') === orderId) || null
}

function isUserCancelledWxAction(err) {
  const text = String((err && (err.errMsg || err.message)) || '').toLowerCase()
  return text.includes('cancel')
}

function makePhoneCall(phoneNumber) {
  return new Promise((resolve, reject) => {
    wx.makePhoneCall({
      phoneNumber,
      success: () => resolve(true),
      fail: (err) => reject(err),
    })
  })
}

function openLocation(options = {}) {
  const latitude = Number(options.latitude)
  const longitude = Number(options.longitude)
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return Promise.reject(new Error('INVALID_COORDINATE'))
  }
  return new Promise((resolve, reject) => {
    wx.openLocation({
      latitude,
      longitude,
      scale: Number(options.scale) || 18,
      name: String(options.name || '').trim(),
      address: String(options.address || '').trim(),
      success: () => resolve(true),
      fail: (err) => reject(err),
    })
  })
}

function showActionSheetPick(itemList) {
  const list = Array.isArray(itemList) ? itemList.filter(Boolean) : []
  if (!list.length) return Promise.resolve(-1)
  return new Promise((resolve, reject) => {
    wx.showActionSheet({
      itemList: list,
      success: (res) => resolve(Number((res && res.tapIndex) || 0)),
      fail: (err) => {
        if (isUserCancelledWxAction(err)) {
          resolve(-1)
          return
        }
        reject(err)
      },
    })
  })
}

function uniqueTextList(values) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(values) ? values : []) {
    const v = String(raw || '').trim()
    if (!v) continue
    const key = v.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}

async function geocodeAddressBestEffort(addressText) {
  const base = String(addressText || '').trim()
  const candidates = uniqueTextList([base, `${base}, France`, `${base}, FR`, `${base} France`])
  let lastFailure = null
  for (const query of candidates) {
    const result = await geocodeAddressDirect(query, 1)
    if (result && result.ok) {
      return { ok: true, result, usedQuery: query }
    }
    lastFailure = result || null
  }
  return { ok: false, result: lastFailure, usedQuery: candidates[0] || '' }
}

function buildOrderActionItems(order, pageData) {
  const o = order || {}
  const data = pageData || {}
  const items = []
  if (data.enableQuickCall) {
    items.push({
      key: 'call',
      label: o.phoneRaw ? `📞 拨打电话 ${o.phoneText || ''}` : '📞 拨打电话（无号码）',
    })
  }
  if (data.enableGoogleNav) {
    items.push({
      key: 'nav',
      label: o.canGoogleNavigate ? '🧭 导航到客户地址' : '🧭 导航（地址缺失）',
    })
  }
  if (data.canOperate) {
    items.push({
      key: 'handoff',
      label: o.isDelivered ? '🚚 撤销送达' : '🚚 标记送达',
    })
    items.push({
      key: 'paid',
      label: o.isPaid ? '💰 撤销收款' : '💰 标记收款',
    })
  }
  return items
}

function shortCustomerNameForMenu(order) {
  const o = order || {}
  const name = String(o.customerNameText || '').trim() || '匿名客户'
  return name.length > 12 ? `${name.slice(0, 12)}…` : name
}

function createRunPage(config) {
  const cfg = {
    listSalesAction: '',
    getRunAction: '',
    enableQuickCall: true,
    enableGoogleNav: false,
    splitByDelivered: false,
    emptySelectorLabel: '暂无可执行开单',
    preferredStatuses: [],
    appendedHintFormatter: null,
    progressTitle: '执行进度',
    activeOrderCountLabel: '有效订单',
    noSaleText: '',
    listActionHint: '点任一订单弹出操作菜单',
    pendingTitle: '未交付',
    deliveredTitle: '已交付',
    pendingNote: '',
    deliveredNote: '',
    emptyPendingText: '暂无未交付订单',
    emptyDeliveredText: '暂无已交付订单',
    ...config,
  }

  createPage({
    data: {
      loadPhase: 'loading',
      loadingSales: false,
      loadingRun: false,
      operatingOrderId: '',
      saleOptions: [{ label: '加载中...', value: '', status: '' }],
      saleIndex: 0,
      saleLabel: '加载中...',
      sale: null,
      canOperate: false,
      enableQuickCall: !!cfg.enableQuickCall,
      enableGoogleNav: !!cfg.enableGoogleNav,
      summary: {
        totalActiveOrders: 0,
        deliveredOrders: 0,
        paidOrders: 0,
        doneOrders: 0,
        remainingOrders: 0,
      },
      orders: [],
      pendingOrders: [],
      deliveredOrders: [],
      pendingCollapsed: false,
      deliveredCollapsed: false,
      appendedHint: '',
      progressTitle: String(cfg.progressTitle || '').trim() || '执行进度',
      activeOrderCountLabel: String(cfg.activeOrderCountLabel || '').trim() || '有效订单',
      noSaleText: String(cfg.noSaleText || cfg.emptySelectorLabel || '').trim() || '暂无可执行开单',
      listActionHint: String(cfg.listActionHint || '').trim() || '点任一订单弹出操作菜单',
      pendingTitle: String(cfg.pendingTitle || '').trim() || '未交付',
      deliveredTitle: String(cfg.deliveredTitle || '').trim() || '已交付',
      pendingNote: String(cfg.pendingNote || '').trim(),
      deliveredNote: String(cfg.deliveredNote || '').trim(),
      emptyPendingText: String(cfg.emptyPendingText || '').trim() || '暂无未交付订单',
      emptyDeliveredText: String(cfg.emptyDeliveredText || '').trim() || '暂无已交付订单',
    },

    onLoad(query) {
      this.prefSaleId = String((query && query.saleId) || '').trim()
    },

    onShow() {
      this.reload()
    },

    async reload() {
      if (this.data.loadingSales) return
      this.setData({ loadingSales: true })
      const finishLoadPhase = () => {
        if (this.data.loadPhase !== 'ready') {
          this.setData({ loadPhase: 'ready' })
        }
      }
      if (this.data.loadPhase !== 'ready') this.setData({ loadPhase: 'loading' })
      try {
        const salesRes = await call('admin', cfg.listSalesAction, { limit: 50, includeCompleted: true })
        if (!salesRes.ok) {
          finishLoadPhase()
          this.setData({
            saleOptions: [{ label: '加载失败', value: '', status: '' }],
            saleIndex: 0,
            saleLabel: '加载失败',
            sale: null,
            canOperate: false,
            orders: [],
            pendingOrders: [],
            deliveredOrders: [],
            appendedHint: '',
          })
          wx.showToast({ title: salesRes.message || '加载失败', icon: 'none' })
          return
        }
        const sales = Array.isArray(salesRes.data && salesRes.data.sales) ? salesRes.data.sales : []
        const opts = sales.map((s) => ({
          label: buildSaleLabel(s),
          value: String(s._id || ''),
          status: String(s.status || ''),
        }))
        if (!opts.length) opts.push({ label: cfg.emptySelectorLabel, value: '', status: '' })
        const currentValue = (this.data.saleOptions[this.data.saleIndex] && this.data.saleOptions[this.data.saleIndex].value) || ''
        const saleIndex = pickSaleIndex(opts, this.prefSaleId, currentValue, cfg.preferredStatuses)
        const picked = opts[saleIndex] || { label: '未选择', value: '' }
        this.setData({
          saleOptions: opts,
          saleIndex,
          saleLabel: picked.label || '未选择',
        })
        finishLoadPhase()
        await this.loadRun()
      } finally {
        this.setData({ loadingSales: false })
      }
    },

    onPickSale(e) {
      const saleIndex = Number((e.detail && e.detail.value) || 0)
      const picked = this.data.saleOptions[saleIndex] || { label: '未选择', value: '' }
      this.setData({
        saleIndex,
        saleLabel: picked.label || '未选择',
        appendedHint: '',
      })
      this.loadRun()
    },

    async loadRun() {
      const option = this.data.saleOptions[this.data.saleIndex] || null
      const saleId = String((option && option.value) || '').trim()
      const finishLoadPhase = () => {
        if (this.data.loadPhase !== 'ready') {
          this.setData({ loadPhase: 'ready' })
        }
      }
      if (!saleId) {
        this.setData({
          sale: null,
          canOperate: false,
          orders: [],
          pendingOrders: [],
          deliveredOrders: [],
          appendedHint: '',
          summary: { totalActiveOrders: 0, deliveredOrders: 0, paidOrders: 0, doneOrders: 0, remainingOrders: 0 },
        })
        finishLoadPhase()
        return
      }
      if (this.data.loadingRun) return
      this.setData({ loadingRun: true })
      const res = await call('admin', cfg.getRunAction, { saleId })
      this.setData({ loadingRun: false })
      finishLoadPhase()
      if (!res.ok) {
        this.setData({
          sale: null,
          canOperate: false,
          orders: [],
          pendingOrders: [],
          deliveredOrders: [],
          appendedHint: '',
          summary: { totalActiveOrders: 0, deliveredOrders: 0, paidOrders: 0, doneOrders: 0, remainingOrders: 0 },
        })
        wx.showToast({ title: res.message || '加载失败', icon: 'none' })
        return
      }
      const rawOrders = Array.isArray(res.data && res.data.orders) ? res.data.orders : []
      const decoratedOrders = rawOrders.map(decorateRunOrder)
      const split = cfg.splitByDelivered
        ? splitOrdersByDelivered(decoratedOrders)
        : { pending: decoratedOrders, delivered: [] }
      const appendedOrderIds =
        (res.data && res.data.derived && Array.isArray(res.data.derived.appendedOrderIds) && res.data.derived.appendedOrderIds) || []
      this.setData({
        sale: res.data && res.data.sale ? { ...res.data.sale, statusText: saleStatusText(res.data.sale.status) } : null,
        canOperate: !!(res.data && res.data.canOperate),
        summary:
          (res.data && res.data.summary) ||
          { totalActiveOrders: 0, deliveredOrders: 0, paidOrders: 0, doneOrders: 0, remainingOrders: 0 },
        orders: decoratedOrders,
        pendingOrders: split.pending,
        deliveredOrders: split.delivered,
        appendedHint:
          typeof cfg.appendedHintFormatter === 'function' && appendedOrderIds.length
            ? cfg.appendedHintFormatter(appendedOrderIds.length)
            : '',
      })
    },

    togglePendingCollapsed() {
      this.setData({ pendingCollapsed: !this.data.pendingCollapsed })
    },

    toggleDeliveredCollapsed() {
      this.setData({ deliveredCollapsed: !this.data.deliveredCollapsed })
    },

    openOrderDetailById(orderId) {
      const id = String(orderId || '').trim()
      if (!id) return
      wx.navigateTo({ url: `/pages/admin/order-detail/index?orderId=${encodeURIComponent(id)}` })
    },

    async onOpenOrderActions(e) {
      const orderId = readDatasetString(e, 'id')
      const order = findOrderById(this.data.orders, orderId)
      if (!order || this.data.loadingRun || this.data.operatingOrderId) return
      const customerName = shortCustomerNameForMenu(order)
      const actionItems = [
        { key: 'detail', label: `📄 订单详情（${customerName}）` },
        ...buildOrderActionItems(order, this.data),
      ]
      let pickedIndex = -1
      try {
        pickedIndex = await showActionSheetPick(actionItems.map((it) => it.label))
      } catch (err) {
        await showErrorDialog(
          {
            message: '无法打开操作菜单',
            code: 'ORDER_ACTION_SHEET_FAILED',
            detail: { orderId, err },
          },
          { title: '操作失败' }
        )
        return
      }
      if (pickedIndex < 0 || pickedIndex >= actionItems.length) return
      const picked = actionItems[pickedIndex]
      if (!picked || !picked.key) return
      if (picked.key === 'detail') {
        this.openOrderDetailById(orderId)
        return
      }
      if (picked.key === 'call') {
        await this.callCustomerByOrderId(orderId)
        return
      }
      if (picked.key === 'nav') {
        await this.openGoogleNavByOrderId(orderId)
        return
      }
      if (picked.key === 'handoff') {
        await this.toggleHandoffByOrderId(orderId)
        return
      }
      if (picked.key === 'paid') {
        await this.togglePaidByOrderId(orderId)
      }
    },

    async callCustomerByOrderId(orderId) {
      if (!this.data.enableQuickCall) return
      const id = String(orderId || '').trim()
      if (!id) return
      const order = findOrderById(this.data.orders, id)
      if (!order) return
      const phoneNumber = String(order.phoneRaw || '').trim()
      if (!phoneNumber) {
        await showErrorDialog({ message: '该订单没有可拨打的手机号' }, { title: '拨号失败' })
        return
      }
      try {
        await makePhoneCall(phoneNumber)
      } catch (err) {
        if (isUserCancelledWxAction(err)) return
        await showErrorDialog(
          { message: '无法拨通电话', code: 'PHONE_CALL_FAILED', detail: { orderId: id, phoneNumber, err } },
          { title: '拨号失败' }
        )
      }
    },

    async openGoogleNavByOrderId(orderId) {
      if (!this.data.enableGoogleNav) return
      const id = String(orderId || '').trim()
      if (!id) return
      const order = findOrderById(this.data.orders, id)
      if (!order) {
        await showErrorDialog({ message: '订单不存在或已刷新', detail: { orderId: id } }, { title: '导航失败' })
        return
      }
      if (!order.canGoogleNavigate) {
        await showErrorDialog(
          { message: '该订单缺少可导航地址', detail: { orderId: id, fulfillmentType: order.fulfillmentType } },
          { title: '导航失败' }
        )
        return
      }

      const geocodeState = await geocodeAddressBestEffort(order.addressRaw)
      if (!geocodeState.ok || !(geocodeState.result && geocodeState.result.ok)) {
        await showErrorDialog(
          {
            message: '地址定位失败，请先完善门牌号/邮编/城市后再导航',
            code: 'GEOCODE_FAILED',
            detail: {
              orderId: id,
              address: order.addressRaw,
              geocode: geocodeState.result,
              query: geocodeState.usedQuery,
            },
          },
          { title: '导航失败' }
        )
        return
      }

      const geocode = geocodeState.result
      try {
        await openLocation({
          latitude: geocode.latitude,
          longitude: geocode.longitude,
          name: order.customerNameText || '配送地址',
          address: order.addressRaw,
          scale: 18,
        })
      } catch (err) {
        if (isUserCancelledWxAction(err)) return
        await showErrorDialog(
          {
            message: '无法打开地图导航',
            code: 'OPEN_LOCATION_FAILED',
            detail: {
              orderId: id,
              address: order.addressRaw,
              latitude: geocode.latitude,
              longitude: geocode.longitude,
              query: geocodeState.usedQuery,
              err,
            },
          },
          { title: '导航失败' }
        )
      }
    },

    async toggleHandoffByOrderId(orderId) {
      if (!this.data.canOperate || this.data.loadingRun) return
      const id = String(orderId || '').trim()
      if (!id) return
      const order = findOrderById(this.data.orders, id)
      if (!order) return
      const current = String(order.handoffStatus || '').trim()
      const next = current === 'DELIVERED' ? 'PENDING' : 'DELIVERED'
      const msg = next === 'DELIVERED' ? '已标记送达' : '已撤销送达'
      await this.applyOrderProgress(id, { handoffStatus: next }, msg)
    },

    async togglePaidByOrderId(orderId) {
      if (!this.data.canOperate || this.data.loadingRun) return
      const id = String(orderId || '').trim()
      if (!id) return
      const order = findOrderById(this.data.orders, id)
      if (!order) return
      const current = String(order && order.payment && order.payment.paidStatus).trim()
      const next = current === 'PAID' ? 'UNPAID' : 'PAID'
      const msg = next === 'PAID' ? '已标记收款' : '已撤销收款'
      await this.applyOrderProgress(id, { paidStatus: next }, msg)
    },

    async applyOrderProgress(orderId, patch, successTitle) {
      if (this.data.operatingOrderId) return
      const saleId = String((this.data.sale && this.data.sale._id) || '').trim()
      this.setData({ operatingOrderId: orderId })
      const res = await call('admin', 'updateOrderFulfillmentProgress', {
        orderId,
        saleId,
        ...patch,
      })
      this.setData({ operatingOrderId: '' })
      if (!res.ok) {
        wx.showToast({ title: res.message || '更新失败', icon: 'none' })
        await this.loadRun()
        return
      }
      wx.showToast({ title: successTitle || '已更新', icon: 'success' })
      await this.loadRun()
    },
  })
}

module.exports = {
  createRunPage,
}
