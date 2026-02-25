const { call } = require('../../../utils/api')
const { invalidateSnapshot } = require('../../../utils/app-snapshot')
const { centToEuro } = require('../../../utils/format')
const { normalizePhone, isPhoneValid } = require('../../../utils/phone')
const { normalizeFrAddress, isFrAddressValid } = require('../../../utils/fr-address')
const { suggestAddressDirect } = require('../../../utils/address-suggest')
const { createPage } = require('../../../utils/create-page')
const { calcEditableTotals, buildPayloadItems } = require('../../../utils/order-editor')

const CUSTOMER_ACTION_OPTIONS = [
  { label: '选择已有客户', value: 'select_existing' },
  { label: '新建店主代录客户', value: 'create_manual' },
]

const FULFILLMENT_OPTIONS = [
  { label: '配送', value: 'delivery' },
  { label: '自取', value: 'pickup' },
]

const ADDRESS_MODE_OPTIONS = [
  { label: '客户保存地址', value: 'saved' },
  { label: '手动地址', value: 'manual' },
]

const PAYMENT_METHOD_OPTIONS = [
  { label: '现金', value: 'cash' },
  { label: '微信转账', value: 'wechat_transfer' },
  { label: '支付宝转账', value: 'alipay_transfer' },
]

const PAID_STATUS_OPTIONS = [
  { label: '未收款', value: 'UNPAID' },
  { label: '已收款', value: 'PAID' },
]

const HANDOFF_STATUS_OPTIONS = [
  { label: '未交付', value: 'PENDING' },
  { label: '已交付', value: 'DELIVERED' },
]

function blankManualAddress() {
  return {
    label: '',
    line1: '',
    line2: '',
    postalCode: '',
    city: '',
    country: 'FR',
    phone: '',
  }
}

function toSelectableDish(row) {
  return {
    _id: String((row && row._id) || ''),
    name: String((row && row.name) || '').trim(),
    priceCents: Number((row && row.priceCents) || 0),
    priceEuro: centToEuro(Number((row && row.priceCents) || 0)),
    isActive: !!(row && row.isActive),
    inCurrentSale: !!(row && row.inCurrentSale),
    limitQty: Number((row && row.limitQty) || 0),
    soldQty: Number((row && row.soldQty) || 0),
    remainingQty: Number((row && row.remainingQty) || 0),
    selectedQty: 0,
  }
}

function buildAddDishOptionsFromSaleDishes(saleDishes) {
  return (Array.isArray(saleDishes) ? saleDishes : [])
    .filter((d) => !!(d && d.isActive) && Number(d.selectedQty || 0) <= 0)
    .map((d) => ({
      dishId: String((d && d._id) || ''),
      label: `${String((d && d.name) || '').trim()} €${String((d && d.priceEuro) || '0.00')}${
        d && d.inCurrentSale ? '' : '（未在本期开单）'
      }`,
    }))
}

function line1FromSuggestion(suggestion) {
  const raw = String((suggestion && (suggestion.line1 || suggestion.label)) || '').trim()
  const parts = raw.split(/\s+/).filter(Boolean)
  if (parts.length >= 2 && String(parts[0]).toLowerCase() === String(parts[1]).toLowerCase()) {
    parts.splice(1, 1)
  }
  return parts.join(' ')
}

function buildEditableItemsFromSaleDishes(saleDishes) {
  return (Array.isArray(saleDishes) ? saleDishes : [])
    .filter((d) => Number(d.selectedQty || 0) > 0)
    .map((d) => {
      const qty = Math.max(0, Number(d.selectedQty || 0))
      const unitPriceCents = Number(d.priceCents || 0)
      return {
        dishId: d._id,
        dishName: d.name,
        unitPriceCents,
        unitPriceEuro: centToEuro(unitPriceCents),
        qty,
        lineTotalEuro: centToEuro(unitPriceCents * qty),
      }
    })
}

function setDishSelectionState(page, saleDishes) {
  const editableItems = buildEditableItemsFromSaleDishes(saleDishes)
  const addDishOptions = buildAddDishOptionsFromSaleDishes(saleDishes)
  const nextAddDishIndex = safePickerIndex(page.data && page.data.addDishIndex, addDishOptions)
  page.setData({
    saleDishes,
    editableItems,
    editableTotals: calcEditableTotals(editableItems),
    addDishOptions,
    addDishIndex: nextAddDishIndex,
  })
}

function applyDishQtyDelta(saleDishes, dishId, delta) {
  return (Array.isArray(saleDishes) ? saleDishes : []).map((d) => {
    if (String(d._id || '') !== String(dishId || '')) return d
    const nextQty = Math.max(0, Number(d.selectedQty || 0) + Number(delta || 0))
    return { ...d, selectedQty: nextQty }
  })
}

function removeDishQty(saleDishes, dishId) {
  return (Array.isArray(saleDishes) ? saleDishes : []).map((d) => {
    if (String(d._id || '') !== String(dishId || '')) return d
    return { ...d, selectedQty: 0 }
  })
}

function safePickerIndex(rawValue, options) {
  const idx = Number(rawValue || 0)
  const len = Array.isArray(options) ? options.length : 0
  if (len <= 0) return 0
  return Number.isFinite(idx) && idx >= 0 && idx < len ? idx : 0
}

function formatAddressLine(addr) {
  if (!addr) return ''
  return [addr.line1, addr.line2, addr.postalCode, addr.city, addr.country].filter(Boolean).join(', ')
}

function decorateCustomerSummary(row) {
  const customerOpenId = String((row && row.customerOpenId) || '').trim()
  const nickname = String((row && row.nickname) || '').trim()
  const defaultPhone = normalizePhone(row && row.defaultPhone)
  const profilePhone = normalizePhone(row && row.profilePhone)
  return {
    customerOpenId,
    nickname,
    nicknameText: nickname || '未设置昵称',
    isManualCreated: !!(row && row.isManualCreated),
    sourceBadgeText: row && row.isManualCreated ? '店主代录' : '',
    defaultPhone: defaultPhone || profilePhone || '',
    addressCount: Number((row && row.addressCount) || 0),
    defaultAddressText: String((row && row.defaultAddressText) || '').trim(),
    updatedAt: (row && row.updatedAt) || null,
    searchText: String((row && row.searchText) || '').toLowerCase(),
  }
}

function filterCustomers(rows, query) {
  const arr = Array.isArray(rows) ? rows : []
  const q = String(query || '').trim().toLowerCase()
  if (!q) return arr
  return arr.filter((row) => {
    const text = String((row && row.searchText) || '').toLowerCase()
    if (text.includes(q)) return true
    const fallback = [
      String((row && row.nicknameText) || ''),
      String((row && row.defaultPhone) || ''),
      String((row && row.customerOpenId) || ''),
    ]
      .join(' ')
      .toLowerCase()
    return fallback.includes(q)
  })
}

function normalizeAddressOptionRow(addr, defaultAddressId) {
  const id = String((addr && addr.id) || '').trim()
  const label = String((addr && addr.label) || '').trim()
  const title = label || `${String((addr && addr.line1) || '').trim()} ${String((addr && addr.city) || '').trim()}`.trim()
  return {
    ...addr,
    id,
    title: title || '未命名地址',
    detail: formatAddressLine(addr),
    phoneText: normalizePhone(addr && addr.phone),
    isDefault: id && id === String(defaultAddressId || '').trim(),
  }
}

function pickDefaultAddressId(addresses, defaultAddressId) {
  const target = String(defaultAddressId || '').trim()
  const arr = Array.isArray(addresses) ? addresses : []
  if (target && arr.some((x) => String((x && x.id) || '').trim() === target)) return target
  return String((arr[0] && arr[0].id) || '')
}

function getSelectedAddress(addresses, selectedAddressId) {
  const id = String(selectedAddressId || '').trim()
  return (Array.isArray(addresses) ? addresses : []).find((x) => String((x && x.id) || '').trim() === id) || null
}

function setRefresherTriggered(page, triggered) {
  page.setData({ refresherTriggered: !!triggered })
}

function buildAddressPayloadForSubmit(raw) {
  const normalized = normalizeFrAddress(raw, { requireLabel: false })
  if (!normalized) return null
  return {
    label: String(normalized.label || '').trim(),
    line1: String(normalized.line1 || '').trim(),
    line2: String(normalized.line2 || '').trim(),
    postalCode: String(normalized.postalCode || '').trim(),
    city: String(normalized.city || '').trim(),
    country: 'FR',
    phone: normalizePhone(normalized.phone || ''),
  }
}

function showToast(title) {
  wx.showToast({ title: title || '操作失败', icon: 'none' })
}

createPage({
  data: {
    refresherTriggered: false,
    loading: false,
    loadPhase: 'loading',
    submitting: false,
    sale: null,
    saleOpen: false,
    saleDishes: [],
    editableItems: [],
    editableTotals: { qty: 0, amountEuro: '0.00' },
    addDishOptions: [],
    addDishIndex: 0,

    customerActionOptions: CUSTOMER_ACTION_OPTIONS,
    customerActionIndex: 0,
    customerAction: CUSTOMER_ACTION_OPTIONS[0].value,
    customerQuery: '',
    recentCustomers: [],
    filteredCustomers: [],
    selectedCustomerOpenId: '',
    selectedCustomer: null,
    customerAddresses: [],
    selectedAddressId: '',
    selectedAddressIndex: 0,

    fulfillmentOptions: FULFILLMENT_OPTIONS,
    fulfillmentIndex: 0,
    fulfillmentTypeDraft: FULFILLMENT_OPTIONS[0].value,
    addressModeOptions: ADDRESS_MODE_OPTIONS,
    addressModeIndex: 0,
    addressMode: ADDRESS_MODE_OPTIONS[0].value,
    manualAddress: blankManualAddress(),
    manualAddressSuggestions: [],
    manualAddressLine1Focused: false,
    pickupPhoneDraft: '',

    newManualCustomerNickname: '',
    newManualCustomerProfilePhone: '',

    paymentMethodOptions: PAYMENT_METHOD_OPTIONS,
    paymentMethodIndex: 0,
    paidStatusOptions: PAID_STATUS_OPTIONS,
    paidStatusIndex: 0,
    handoffStatusOptions: HANDOFF_STATUS_OPTIONS,
    handoffStatusIndex: 0,
    remarkDraft: '',
  },

  onLoad() {
    this._manualAddrSuggestReqId = 0
    this._manualAddrSuggestTimer = null
    this._isPickingManualAddrSuggestion = false
    this.reload()
  },

  onUnload() {
    if (this._manualAddrSuggestTimer) clearTimeout(this._manualAddrSuggestTimer)
    this._manualAddrSuggestTimer = null
    this._isPickingManualAddrSuggestion = false
  },

  onPullDownRefresh() {
    this.reload().finally(() => {
      wx.stopPullDownRefresh()
    })
  },

  async reload() {
    const finishLoadPhase = () => {
      if (this.data.loadPhase !== 'ready') this.setData({ loadPhase: 'ready' })
    }
    if (this.data.loadPhase !== 'ready') this.setData({ loadPhase: 'loading' })
    setRefresherTriggered(this, true)
    this.setData({ loading: true })
    const res = await call('admin', 'getManualOrderCreateBootstrap')
    this.setData({ loading: false })
    setRefresherTriggered(this, false)
    finishLoadPhase()
    if (!res.ok) {
      showToast(res.message || '加载失败')
      return
    }
    const sale = (res.data && res.data.sale) || null
    const saleOpen = !!(sale && String(sale.status || '') === 'OPEN')
    const saleDishes = (Array.isArray(res.data && res.data.dishes) ? res.data.dishes : [])
      .map(toSelectableDish)
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
    const recentCustomers = (Array.isArray(res.data && res.data.recentCustomers) ? res.data.recentCustomers : []).map(decorateCustomerSummary)
    this.setData({
      sale,
      saleOpen,
      recentCustomers,
      filteredCustomers: filterCustomers(recentCustomers, this.data.customerQuery),
    })
    setDishSelectionState(this, saleDishes)
  },

  onCustomerActionPick(e) {
    const idx = safePickerIndex(e && e.detail && e.detail.value, CUSTOMER_ACTION_OPTIONS)
    const picked = CUSTOMER_ACTION_OPTIONS[idx]
    const nextAction = picked.value
    const patch = {
      customerActionIndex: idx,
      customerAction: nextAction,
    }
    if (nextAction === 'create_manual') {
      patch.selectedCustomerOpenId = ''
      patch.selectedCustomer = null
      patch.customerAddresses = []
      patch.selectedAddressId = ''
      patch.selectedAddressIndex = 0
      patch.addressMode = 'manual'
      patch.addressModeIndex = 1
      patch.manualAddressSuggestions = []
      patch.manualAddressLine1Focused = false
    } else if (this.data.fulfillmentTypeDraft === 'delivery') {
      patch.addressMode = this.data.customerAddresses.length > 0 ? this.data.addressMode : 'manual'
      patch.addressModeIndex = patch.addressMode === 'manual' ? 1 : 0
    }
    this.setData(patch)
  },

  onCustomerQueryInput(e) {
    const customerQuery = String((e && e.detail && e.detail.value) || '')
    this.setData({
      customerQuery,
      filteredCustomers: filterCustomers(this.data.recentCustomers, customerQuery),
    })
  },

  async pickCustomer(e) {
    const customerOpenId = String((e.currentTarget.dataset && e.currentTarget.dataset.id) || '').trim()
    if (!customerOpenId) return
    const reqSeq = (Number(this._pickCustomerReqSeq) || 0) + 1
    this._pickCustomerReqSeq = reqSeq
    const isStalePick = () => {
      if (reqSeq !== this._pickCustomerReqSeq) return true
      return String(this.data.selectedCustomerOpenId || '').trim() !== customerOpenId
    }
    const pickedRow =
      this.data.recentCustomers.find((x) => String((x && x.customerOpenId) || '').trim() === customerOpenId) || null
    this.setData({ selectedCustomerOpenId: customerOpenId })
    const res = await call('admin', 'getCustomerDetail', { customerOpenId })
    if (isStalePick()) return
    if (!res.ok) {
      showToast(res.message || '加载客人失败')
      return
    }
    const rawCustomer = (res.data && res.data.customer) || null
    const rawAddresses = Array.isArray(rawCustomer && rawCustomer.addresses) ? rawCustomer.addresses : []
    const defaultAddressId = String((rawCustomer && rawCustomer.defaultAddressId) || '').trim()
    const customerAddresses = rawAddresses.map((a) => normalizeAddressOptionRow(a, defaultAddressId))
    const selectedAddressId = pickDefaultAddressId(customerAddresses, defaultAddressId)
    const selectedAddressIndex = Math.max(
      0,
      customerAddresses.findIndex((x) => String((x && x.id) || '').trim() === selectedAddressId)
    )
    const selectedAddress = getSelectedAddress(customerAddresses, selectedAddressId)
    const selectedCustomer = {
      customerOpenId,
      nickname: String((rawCustomer && rawCustomer.nickname) || '').trim(),
      nicknameText: String((rawCustomer && rawCustomer.nickname) || '').trim() || '未设置昵称',
      isManualCreated: !!(pickedRow && pickedRow.isManualCreated),
      sourceBadgeText: pickedRow && pickedRow.isManualCreated ? '店主代录' : '',
      defaultPhone: normalizePhone((selectedAddress && selectedAddress.phoneText) || (pickedRow && pickedRow.defaultPhone) || ''),
      addressCount: customerAddresses.length,
    }
    const patch = {
      selectedCustomerOpenId: customerOpenId,
      selectedCustomer,
      customerAddresses,
      selectedAddressId,
      selectedAddressIndex: selectedAddressIndex >= 0 ? selectedAddressIndex : 0,
    }
    if (this.data.fulfillmentTypeDraft === 'delivery') {
      const hasSaved = customerAddresses.length > 0
      patch.addressMode = hasSaved ? this.data.addressMode : 'manual'
      patch.addressModeIndex = patch.addressMode === 'manual' ? 1 : 0
    }
    if (this.data.fulfillmentTypeDraft === 'pickup' && !String(this.data.pickupPhoneDraft || '').trim()) {
      patch.pickupPhoneDraft = normalizePhone(selectedCustomer.defaultPhone || '')
    }
    if (isStalePick()) return
    this.setData(patch)
  },

  onFulfillmentPick(e) {
    const idx = safePickerIndex(e && e.detail && e.detail.value, FULFILLMENT_OPTIONS)
    const picked = FULFILLMENT_OPTIONS[idx]
    const patch = {
      fulfillmentIndex: idx,
      fulfillmentTypeDraft: picked.value,
    }
    if (picked.value === 'delivery') {
      const forceManual = this.data.customerAction === 'create_manual' || this.data.customerAddresses.length === 0
      patch.addressMode = forceManual ? 'manual' : this.data.addressMode
      patch.addressModeIndex = patch.addressMode === 'manual' ? 1 : 0
    } else if (!String(this.data.pickupPhoneDraft || '').trim() && this.data.selectedCustomer && this.data.selectedCustomer.defaultPhone) {
      patch.pickupPhoneDraft = normalizePhone(this.data.selectedCustomer.defaultPhone)
      patch.manualAddressSuggestions = []
      patch.manualAddressLine1Focused = false
    }
    this.setData(patch)
  },

  onAddressModePick(e) {
    if (this.data.customerAction !== 'select_existing') return
    const idx = safePickerIndex(e && e.detail && e.detail.value, ADDRESS_MODE_OPTIONS)
    const picked = ADDRESS_MODE_OPTIONS[idx]
    if (picked.value === 'saved' && (!Array.isArray(this.data.customerAddresses) || this.data.customerAddresses.length === 0)) {
      showToast('该客户没有保存地址，请使用手动地址')
      return
    }
    this.setData({
      addressModeIndex: idx,
      addressMode: picked.value,
      manualAddressSuggestions: picked.value === 'manual' ? this.data.manualAddressSuggestions : [],
      manualAddressLine1Focused: picked.value === 'manual' ? this.data.manualAddressLine1Focused : false,
    })
    if (picked.value !== 'manual') {
      if (this._manualAddrSuggestTimer) clearTimeout(this._manualAddrSuggestTimer)
      this._manualAddrSuggestTimer = null
      this._manualAddrSuggestReqId = (this._manualAddrSuggestReqId || 0) + 1
      this._isPickingManualAddrSuggestion = false
      this.setData({ manualAddressSuggestions: [], manualAddressLine1Focused: false })
    }
  },

  onPickSavedAddress(e) {
    const safeIdx = safePickerIndex(e && e.detail && e.detail.value, this.data.customerAddresses)
    const picked = this.data.customerAddresses[safeIdx] || null
    if (!picked) return
    this.setData({
      selectedAddressIndex: safeIdx,
      selectedAddressId: String((picked && picked.id) || ''),
    })
  },

  onManualAddressInput(e) {
    const key = String((e.currentTarget.dataset && e.currentTarget.dataset.key) || '')
    if (!key) return
    const value = String((e && e.detail && e.detail.value) || '')
    this.setData({
      manualAddress: {
        ...(this.data.manualAddress || blankManualAddress()),
        [key]: value,
      },
    })
  },

  onManualAddressLine1Input(e) {
    const value = String((e && e.detail && e.detail.value) || '')
    this.setData({
      manualAddress: {
        ...(this.data.manualAddress || blankManualAddress()),
        line1: value,
      },
    })
    if (this._isPickingManualAddrSuggestion) return
    if (this.data.fulfillmentTypeDraft !== 'delivery') return
    const usingManualAddress =
      this.data.customerAction === 'create_manual' ||
      this.data.addressMode === 'manual' ||
      this.data.customerAddresses.length === 0
    if (!usingManualAddress) return
    this.debouncedManualAddressSuggest(value)
  },

  onManualAddressLine1Focus() {
    this.setData({ manualAddressLine1Focused: true })
  },

  onManualAddressLine1Blur() {
    if (this._isPickingManualAddrSuggestion) return
    this.setData({ manualAddressLine1Focused: false, manualAddressSuggestions: [] })
  },

  onManualAddressSuggestionTouchStart() {
    this._isPickingManualAddrSuggestion = true
  },

  debouncedManualAddressSuggest(q) {
    const s = String(q || '').trim()
    if (this._manualAddrSuggestTimer) clearTimeout(this._manualAddrSuggestTimer)
    if (s.length < 3) {
      this.setData({ manualAddressSuggestions: [] })
      return
    }
    const reqId = (this._manualAddrSuggestReqId || 0) + 1
    this._manualAddrSuggestReqId = reqId
    this._manualAddrSuggestTimer = setTimeout(() => {
      this.fetchManualAddressSuggestions(s, reqId)
    }, 250)
  },

  async fetchManualAddressSuggestions(q, reqId) {
    const res = await suggestAddressDirect(q, 5)
    if (reqId !== this._manualAddrSuggestReqId) return
    if (this._isPickingManualAddrSuggestion || !this.data.manualAddressLine1Focused) return
    const latestLine1 = String((this.data.manualAddress && this.data.manualAddress.line1) || '').trim()
    if (latestLine1 !== String(q || '').trim()) return
    if (!res.ok || !Array.isArray(res.suggestions)) {
      this.setData({ manualAddressSuggestions: [] })
      return
    }
    this.setData({ manualAddressSuggestions: res.suggestions })
  },

  pickManualAddressSuggestion(e) {
    if (this._manualAddrSuggestTimer) clearTimeout(this._manualAddrSuggestTimer)
    this._manualAddrSuggestTimer = null
    this._manualAddrSuggestReqId = (this._manualAddrSuggestReqId || 0) + 1
    const idx = Number(e.currentTarget.dataset.i)
    const s = (this.data.manualAddressSuggestions || [])[idx]
    if (!s) {
      this._isPickingManualAddrSuggestion = false
      return
    }
    const current = this.data.manualAddress || blankManualAddress()
    const nextLine1 = line1FromSuggestion(s)
    this.setData({
      manualAddress: {
        ...current,
        line1: nextLine1,
        postalCode: String(s.postalCode || '').trim(),
        city: String(s.city || '').trim(),
      },
      manualAddressSuggestions: [],
      manualAddressLine1Focused: false,
    })
    const clearPickingFlag = () => {
      this._isPickingManualAddrSuggestion = false
    }
    setTimeout(clearPickingFlag, 120)
    wx.hideKeyboard({
      complete: clearPickingFlag,
    })
  },

  onPickupPhoneInput(e) {
    this.setData({ pickupPhoneDraft: String((e && e.detail && e.detail.value) || '') })
  },

  onNewManualNicknameInput(e) {
    this.setData({ newManualCustomerNickname: String((e && e.detail && e.detail.value) || '') })
  },

  onNewManualProfilePhoneInput(e) {
    this.setData({ newManualCustomerProfilePhone: String((e && e.detail && e.detail.value) || '') })
  },

  onPickPaymentMethod(e) {
    this.setData({ paymentMethodIndex: safePickerIndex(e && e.detail && e.detail.value, PAYMENT_METHOD_OPTIONS) })
  },

  onPickPaidStatus(e) {
    this.setData({ paidStatusIndex: safePickerIndex(e && e.detail && e.detail.value, PAID_STATUS_OPTIONS) })
  },

  onPickHandoffStatus(e) {
    this.setData({ handoffStatusIndex: safePickerIndex(e && e.detail && e.detail.value, HANDOFF_STATUS_OPTIONS) })
  },

  onRemarkInput(e) {
    this.setData({ remarkDraft: String((e && e.detail && e.detail.value) || '') })
  },

  onAddDishPick(e) {
    this.setData({ addDishIndex: safePickerIndex(e && e.detail && e.detail.value, this.data.addDishOptions) })
  },

  addDish() {
    const opts = Array.isArray(this.data.addDishOptions) ? this.data.addDishOptions : []
    if (opts.length === 0) return
    const picked = opts[safePickerIndex(this.data.addDishIndex, opts)] || null
    if (!picked || !picked.dishId) return
    setDishSelectionState(this, applyDishQtyDelta(this.data.saleDishes, picked.dishId, 1))
  },

  incDish(e) {
    const dishId = String((e.currentTarget.dataset && e.currentTarget.dataset.id) || '').trim()
    if (!dishId) return
    setDishSelectionState(this, applyDishQtyDelta(this.data.saleDishes, dishId, +1))
  },

  decDish(e) {
    const dishId = String((e.currentTarget.dataset && e.currentTarget.dataset.id) || '').trim()
    if (!dishId) return
    setDishSelectionState(this, applyDishQtyDelta(this.data.saleDishes, dishId, -1))
  },

  clearDish(e) {
    const dishId = String((e.currentTarget.dataset && e.currentTarget.dataset.id) || '').trim()
    if (!dishId) return
    setDishSelectionState(this, removeDishQty(this.data.saleDishes, dishId))
  },

  validateAndBuildSubmitPayload() {
    const sale = this.data.sale
    if (!sale || String(sale.status || '') !== 'OPEN') {
      return { ok: false, message: '当前仅开单中可手动录单' }
    }
    const items = buildPayloadItems(this.data.editableItems || []).filter((it) => Number(it.qty || 0) > 0)
    if (items.length === 0) return { ok: false, message: '请先选择菜品' }

    const customerAction = String(this.data.customerAction || '')
    const payload = {
      saleId: String(sale._id || ''),
      customerAction,
      fulfillmentType: String(this.data.fulfillmentTypeDraft || 'delivery'),
      items,
      payment: {
        method: PAYMENT_METHOD_OPTIONS[this.data.paymentMethodIndex] ? PAYMENT_METHOD_OPTIONS[this.data.paymentMethodIndex].value : 'cash',
        paidStatus: PAID_STATUS_OPTIONS[this.data.paidStatusIndex] ? PAID_STATUS_OPTIONS[this.data.paidStatusIndex].value : 'UNPAID',
      },
      handoffStatus: HANDOFF_STATUS_OPTIONS[this.data.handoffStatusIndex]
        ? HANDOFF_STATUS_OPTIONS[this.data.handoffStatusIndex].value
        : 'PENDING',
      remark: String(this.data.remarkDraft || '').trim(),
    }

    if (customerAction === 'select_existing') {
      const customerOpenId = String(this.data.selectedCustomerOpenId || '').trim()
      if (!customerOpenId) return { ok: false, message: '请选择客户' }
      payload.customerOpenId = customerOpenId
    } else {
      const nickname = String(this.data.newManualCustomerNickname || '').trim()
      if (!nickname) return { ok: false, message: '请填写店主代录客户昵称' }
      const profilePhone = normalizePhone(this.data.newManualCustomerProfilePhone)
      if (profilePhone && !isPhoneValid(profilePhone)) return { ok: false, message: '代录客户电话格式不正确' }
      payload.newManualCustomer = {
        nickname,
      }
      if (profilePhone) payload.newManualCustomer.profilePhone = profilePhone
    }

    if (payload.fulfillmentType === 'pickup') {
      const phone = normalizePhone(this.data.pickupPhoneDraft)
      if (!isPhoneValid(phone)) return { ok: false, message: '请填写有效自取电话' }
      payload.phone = phone
    } else {
      const customerActionIsSelect = customerAction === 'select_existing'
      const canUseSaved = customerActionIsSelect && this.data.addressMode === 'saved' && this.data.customerAddresses.length > 0
      if (canUseSaved) {
        const addressId = String(this.data.selectedAddressId || '').trim()
        if (!addressId) return { ok: false, message: '请选择配送地址' }
        payload.addressMode = 'saved'
        payload.addressId = addressId
      } else {
        const manualAddress = buildAddressPayloadForSubmit(this.data.manualAddress)
        if (!manualAddress || !isFrAddressValid(manualAddress, { requirePhone: true, requireLabel: false })) {
          return { ok: false, message: '请填写完整且有效的配送地址与电话' }
        }
        payload.addressMode = 'manual'
        payload.address = manualAddress
        if (customerAction === 'create_manual') {
          payload.newManualCustomer = payload.newManualCustomer || {
            nickname: String(this.data.newManualCustomerNickname || '').trim(),
          }
          payload.newManualCustomer.defaultAddress = manualAddress
        }
      }
    }

    return { ok: true, payload }
  },

  async submit() {
    if (this.data.submitting) return
    const built = this.validateAndBuildSubmitPayload()
    if (!built.ok) {
      showToast(built.message)
      return
    }
    this.setData({ submitting: true })
    const res = await call('admin', 'createManualOrder', built.payload)
    this.setData({ submitting: false })
    if (!res.ok) {
      if (res.code === 'CUSTOMER_HAS_EDITABLE_ORDER') {
        const conflictOrderId = String((res.detail && res.detail.orderId) || '').trim()
        const modalRes = await new Promise((resolve) => {
          wx.showModal({
            title: '已有可编辑订单',
            content: res.message || '该客户本期已有可编辑订单，请在订单管理里修改。',
            confirmText: conflictOrderId ? '去查看' : '知道了',
            showCancel: !!conflictOrderId,
            success: resolve,
            fail: () => resolve({ confirm: false }),
          })
        })
        if (conflictOrderId && modalRes.confirm) {
          wx.navigateTo({ url: `/pages/admin/order-detail/index?orderId=${encodeURIComponent(conflictOrderId)}` })
        }
        return
      }
      if (res.code === 'ITEM_NOT_ALLOWED') {
        showToast('菜品不可用（可能已停用）')
        return
      }
      showToast(res.message || '创建失败')
      return
    }
    invalidateSnapshot()
    const orderId = String((res.data && res.data.orderId) || '')
    if (!orderId) {
      wx.showToast({ title: '创建成功', icon: 'success' })
      return
    }
    wx.showToast({
      title: Array.isArray(res.data && res.data.autoExpandedLimits) && res.data.autoExpandedLimits.length > 0 ? '已创建（已自动扩容库存）' : '已创建',
      icon: 'success',
      duration: 1200,
    })
    setTimeout(() => {
      wx.redirectTo({ url: `/pages/admin/order-detail/index?orderId=${encodeURIComponent(orderId)}` })
    }, 180)
  },
})
