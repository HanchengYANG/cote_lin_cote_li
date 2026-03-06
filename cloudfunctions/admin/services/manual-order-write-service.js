const crypto = require('crypto')

function toEpochMsLoose(input) {
  if (!input) return 0
  if (typeof input === 'number' && Number.isFinite(input)) return input
  const t = new Date(input).getTime()
  return Number.isFinite(t) ? t : 0
}

function pickLatestDoc(docs) {
  const arr = Array.isArray(docs) ? docs.filter(Boolean).slice() : []
  if (arr.length <= 1) return arr[0] || null
  arr.sort((a, b) => {
    const ta = toEpochMsLoose(a && (a.updatedAt || a.createdAt))
    const tb = toEpochMsLoose(b && (b.updatedAt || b.createdAt))
    return tb - ta
  })
  return arr[0] || null
}

function sanitizeManualCustomerNickname(input) {
  return String(input || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 40)
}

function normalizeManualPaymentMethod(input) {
  const v = String(input || '').trim()
  if (v === 'cash') return 'cash'
  if (v === 'wechat_transfer') return 'wechat_transfer'
  if (v === 'alipay_transfer') return 'alipay_transfer'
  return ''
}

function normalizeManualPaidStatus(input) {
  return String(input || '').trim() === 'PAID' ? 'PAID' : 'UNPAID'
}

function normalizeManualHandoffStatus(input, HANDOFF_STATUS) {
  return String(input || '').trim() === HANDOFF_STATUS.DELIVERED ? HANDOFF_STATUS.DELIVERED : HANDOFF_STATUS.PENDING
}

function buildManualCustomerId() {
  return `manual_guest:${Date.now()}:${crypto.randomBytes(3).toString('hex')}`
}

function normalizeManualDeliveryAddressInput(input, normalizeAddressPayload, normalizePhone) {
  const base = normalizeAddressPayload(input)
  if (!base) return null
  return {
    ...base,
    phone: normalizePhone(input && input.phone),
  }
}

function getDishPiecesPerOrderQtySnapshot(dish, toSafeInt) {
  return Math.max(1, toSafeInt(dish && dish.piecesPerOrderQty, 1))
}

function createManualOrderWriteService(deps) {
  const {
    db,
    _,
    ok,
    fail,
    getAllByPaging,
    ORDER_STATUS,
    HANDOFF_STATUS,
    throwBiz,
    getSaleTx,
    normalizeDishConfigs,
    toSafeInt,
    normalizeOrderItems,
    replaceSaleItemsForSaleTx,
    normalizePhone,
    normalizeAddressPayload,
    normalizeStoredAddresses,
    isPhoneValid,
    buildAddressId,
  } = deps

  return {
    async createManualOrder(event, ctx) {
      const adminOpenId = String((ctx && ctx.openId) || '').trim()
      const saleId = String((event && event.saleId) || '').trim()
      if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')

      const customerAction = String((event && event.customerAction) || '').trim()
      const isSelectExisting = customerAction === 'select_existing'
      const isCreateManual = customerAction === 'create_manual'
      if (!isSelectExisting && !isCreateManual) return fail('BAD_REQUEST', 'Invalid customerAction')

      const fulfillmentType = String((event && event.fulfillmentType) || '').trim()
      if (fulfillmentType !== 'delivery' && fulfillmentType !== 'pickup') return fail('BAD_REQUEST', 'Invalid fulfillmentType')

      const paymentMethod = normalizeManualPaymentMethod(event && event.payment && event.payment.method)
      if (!paymentMethod) return fail('BAD_REQUEST', 'Invalid paymentMethod')
      const paidStatus = normalizeManualPaidStatus(event && event.payment && event.payment.paidStatus)
      const handoffStatus = normalizeManualHandoffStatus(event && event.handoffStatus, HANDOFF_STATUS)

      const itemsInput = normalizeOrderItems(event && event.items)
      if (itemsInput.length === 0) return fail('BAD_REQUEST', 'Empty items')

      const requestedCustomerOpenId = String((event && event.customerOpenId) || '').trim()
      const requestedAddressMode = String((event && event.addressMode) || '').trim() === 'manual' ? 'manual' : 'saved'
      const requestedAddressId = String((event && event.addressId) || '').trim()
      const requestedPickupPhone = normalizePhone(event && event.phone)
      if (fulfillmentType === 'pickup' && requestedPickupPhone && !isPhoneValid(requestedPickupPhone)) {
        return fail('INVALID_PHONE', '请填写有效电话')
      }

      const hasManualAddressInput = !!(event && event.address)
      const requestedManualAddress = hasManualAddressInput
        ? normalizeManualDeliveryAddressInput(event.address, normalizeAddressPayload, normalizePhone)
        : null

      const newManualCustomer = (event && event.newManualCustomer) || null
      const newManualNickname = sanitizeManualCustomerNickname(newManualCustomer && newManualCustomer.nickname)
      const requestedManualProfilePhone = normalizePhone(newManualCustomer && newManualCustomer.profilePhone)
      if (isCreateManual && !newManualNickname) return fail('BAD_REQUEST', '缺少店主代录客户昵称')
      if (requestedManualProfilePhone && !isPhoneValid(requestedManualProfilePhone)) {
        return fail('INVALID_PHONE', '代录客户电话格式不正确')
      }
      const hasManualCustomerDefaultAddressInput = !!(newManualCustomer && newManualCustomer.defaultAddress)
      const requestedManualCustomerDefaultAddress = hasManualCustomerDefaultAddressInput
        ? normalizeManualDeliveryAddressInput(newManualCustomer.defaultAddress, normalizeAddressPayload, normalizePhone)
        : null
      if (hasManualCustomerDefaultAddressInput && !requestedManualCustomerDefaultAddress) {
        return fail('INVALID_ADDRESS', '代录客户默认地址格式不正确')
      }
      if (
        requestedManualCustomerDefaultAddress &&
        requestedManualCustomerDefaultAddress.phone &&
        !isPhoneValid(requestedManualCustomerDefaultAddress.phone)
      ) {
        return fail('INVALID_PHONE', '代录客户默认地址电话格式不正确')
      }

      const remark = String((event && event.remark) || '').trim()

      try {
        const txRes = await db.runTransaction(async (tx) => {
          const sale = await getSaleTx(tx, saleId)
          if (!sale || String((sale && sale.status) || '').trim() !== 'OPEN') {
            throwBiz('SALE_NOT_OPEN_FOR_MANUAL_CREATE', '当前仅开单中可手动录单')
          }

          const normalizedSaleConfigs = normalizeDishConfigs(sale && sale.dishConfigs)

          const qtyByDishId = new Map()
          for (const it of itemsInput) {
            const dishId = String((it && it.dishId) || '').trim()
            const qty = Math.max(0, toSafeInt(it && it.qty, 0))
            if (!dishId || qty <= 0) continue
            qtyByDishId.set(dishId, Math.max(0, toSafeInt(qtyByDishId.get(dishId), 0)) + qty)
          }
          if (qtyByDishId.size === 0) throwBiz('BAD_REQUEST', 'Empty items')

          async function createCustomerAddressTx(customerOpenId, inputAddress, options = {}) {
            const customerId = String(customerOpenId || '').trim()
            if (!customerId) throwBiz('BAD_REQUEST', 'Missing customerOpenId')
            const addr = inputAddress || null
            if (!addr) throwBiz('INVALID_ADDRESS', '配送订单缺少有效地址')
            const phone = normalizePhone(addr.phone || '')
            if (!isPhoneValid(phone)) throwBiz('INVALID_PHONE', '请填写有效电话')

            const now = options.now || db.serverDate()
            const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now()
            const addrId = buildAddressId()
            await tx.collection('customer_addresses').doc(addrId).set({
              data: {
                customerOpenId: customerId,
                id: addrId,
                label: String(addr.label || '').trim(),
                line1: String(addr.line1 || '').trim(),
                line2: String(addr.line2 || '').trim(),
                postalCode: String(addr.postalCode || '').trim(),
                city: String(addr.city || '').trim(),
                phone,
                country: 'FR',
                createdAtMs: nowMs,
                updatedAtMs: nowMs,
                createdAt: now,
                updatedAt: now,
              },
            })
            return addrId
          }

          async function createManualCustomerTx() {
            const now = db.serverDate()
            const nowMs = Date.now()
            let customerId = ''
            for (let i = 0; i < 5; i += 1) {
              const candidate = buildManualCustomerId()
              let exists = false
              try {
                const got = await tx.collection('customer_profiles').doc(candidate).get()
                exists = !!(got && got.data)
              } catch (err) {
                exists = false
              }
              if (exists) continue
              customerId = candidate
              break
            }
            if (!customerId) throwBiz('TX_FAILED', '创建代录客户失败')

            const saveDefaultAddress =
              requestedManualCustomerDefaultAddress || (fulfillmentType === 'delivery' ? requestedManualAddress : null)

            let defaultAddressId = ''
            if (saveDefaultAddress) {
              defaultAddressId = await createCustomerAddressTx(customerId, saveDefaultAddress, { now, nowMs })
            }

            let profilePhone = requestedManualProfilePhone
            if (!profilePhone && fulfillmentType === 'pickup' && requestedPickupPhone && isPhoneValid(requestedPickupPhone)) {
              profilePhone = requestedPickupPhone
            }
            if (!profilePhone && saveDefaultAddress && saveDefaultAddress.phone && isPhoneValid(saveDefaultAddress.phone)) {
              profilePhone = normalizePhone(saveDefaultAddress.phone)
            }

            await tx.collection('customer_profiles').doc(customerId).set({
              data: {
                openId: customerId,
                nickname: newManualNickname,
                profilePhone: profilePhone || '',
                defaultAddressId,
                isManualCreated: true,
                createdByAdminOpenId: adminOpenId || '',
                createdAt: now,
                updatedAt: now,
              },
            })
            return { customerId, defaultAddressId }
          }

          let customerOpenId = ''
          let createdManualCustomerDefaultAddressId = ''
          if (isSelectExisting) {
            customerOpenId = requestedCustomerOpenId
            if (!customerOpenId) throwBiz('BAD_REQUEST', 'Missing customerOpenId')
            let profileExists = false
            try {
              const got = await tx.collection('customer_profiles').doc(customerOpenId).get()
              profileExists = !!(got && got.data)
            } catch (err) {
              profileExists = false
            }
            if (!profileExists) throwBiz('NOT_FOUND', 'Customer not found')
          } else {
            const createdManual = await createManualCustomerTx()
            customerOpenId = String((createdManual && createdManual.customerId) || '').trim()
            createdManualCustomerDefaultAddressId = String((createdManual && createdManual.defaultAddressId) || '').trim()
          }

          let customerProfile = null
          try {
            const got = await tx.collection('customer_profiles').doc(customerOpenId).get()
            customerProfile = got && got.data ? got.data : null
          } catch (err) {
            customerProfile = null
          }
          if (!customerProfile) throwBiz('NOT_FOUND', 'Customer not found')

          let customerAddressRows = []
          try {
            customerAddressRows = await getAllByPaging(
              (skip, limit) => tx.collection('customer_addresses').where({ customerOpenId }).skip(skip).limit(limit),
              { pageSize: 100 }
            )
          } catch (err) {
            customerAddressRows = []
          }
          const customerAddresses = normalizeStoredAddresses(customerAddressRows)

          let editableOrders = []
          try {
            const r = await tx
              .collection('orders')
              .where({
                saleId,
                customerOpenId,
                status: _.in([ORDER_STATUS.ACTIVE, ORDER_STATUS.PENDING_REVIEW]),
              })
              .limit(20)
              .get()
            editableOrders = (r && r.data) || []
          } catch (err) {
            editableOrders = []
          }
          const latestEditableOrder = pickLatestDoc(editableOrders)
          if (latestEditableOrder) {
            throwBiz('CUSTOMER_HAS_EDITABLE_ORDER', '该客户本期已有可编辑订单，请在订单管理里修改', {
              orderId: String((latestEditableOrder && latestEditableOrder._id) || '').trim(),
            })
          }

          let orderContactPhone = ''
          let orderAddressId = null
          let deliveryTimeSlotLabelSnapshot = null
          let acceptDeliverySlot = false

          if (fulfillmentType === 'delivery') {
            const effectiveAddressMode = isCreateManual ? 'manual' : requestedAddressMode
            if (effectiveAddressMode === 'saved') {
              const selectedAddress = requestedAddressId ? customerAddresses.find((x) => x.id === requestedAddressId) || null : null
              if (!selectedAddress) throwBiz('BAD_REQUEST', '所选客户地址不存在')
              orderContactPhone = normalizePhone(selectedAddress.phone || '')
              if (!isPhoneValid(orderContactPhone)) throwBiz('INVALID_PHONE', '配送地址缺少有效电话')
              orderAddressId = selectedAddress.id
            } else {
              if (hasManualAddressInput && !requestedManualAddress) throwBiz('INVALID_ADDRESS', '手动地址格式不正确')
              if (!requestedManualAddress) throwBiz('INVALID_ADDRESS', '配送订单缺少有效地址')
              orderContactPhone = normalizePhone(requestedManualAddress.phone || '')
              if (!isPhoneValid(orderContactPhone)) throwBiz('INVALID_PHONE', '请填写有效电话')
              if (isCreateManual && createdManualCustomerDefaultAddressId) {
                orderAddressId = createdManualCustomerDefaultAddressId
              } else {
                orderAddressId = await createCustomerAddressTx(customerOpenId, {
                  ...requestedManualAddress,
                  phone: orderContactPhone,
                })
              }
            }
            if (!orderAddressId) throwBiz('INVALID_ADDRESS', '配送订单缺少有效地址')
            deliveryTimeSlotLabelSnapshot = String((sale && sale.deliveryTimeSlotLabel) || '').trim()
            if (!deliveryTimeSlotLabelSnapshot) throwBiz('BAD_REQUEST', '配送需要时间段')
            acceptDeliverySlot = true
          } else {
            const profilePhone = normalizePhone(customerProfile && customerProfile.profilePhone)
            orderContactPhone = requestedPickupPhone || profilePhone
            if (!isPhoneValid(orderContactPhone)) throwBiz('INVALID_PHONE', '请填写有效电话')
            orderAddressId = null
            deliveryTimeSlotLabelSnapshot = null
            acceptDeliverySlot = false
          }

          const requestedDishIds = Array.from(qtyByDishId.keys())
          const dishRowMap = new Map()
          for (let i = 0; i < requestedDishIds.length; i += 20) {
            const chunk = requestedDishIds.slice(i, i + 20)
            let rows = []
            try {
              const r = await tx.collection('dishes').where({ _id: _.in(chunk) }).get()
              rows = (r && r.data) || []
            } catch (err) {
              rows = []
            }
            for (const row of rows) {
              const id = String((row && row._id) || '').trim()
              if (!id) continue
              dishRowMap.set(id, row)
            }
          }
          const missingDishIds = requestedDishIds.filter((dishId) => !dishRowMap.has(dishId))
          if (missingDishIds.length > 0) throwBiz('ITEM_NOT_FOUND', 'Dish not found', { missingDishIds })

          const orderItems = []
          let totalQty = 0
          let totalAmountCents = 0
          for (const dishId of requestedDishIds) {
            const qty = Math.max(0, toSafeInt(qtyByDishId.get(dishId), 0))
            if (qty <= 0) continue
            const dish = dishRowMap.get(dishId)
            if (!dish || !dish.isActive) throwBiz('ITEM_NOT_ALLOWED', 'Item not allowed', { dishId })
            const dishName = String((dish && dish.name) || '').trim()
            if (!dishName) throwBiz('ITEM_NOT_ALLOWED', 'Item not allowed', { dishId })
            const unitPriceCents = Math.max(0, toSafeInt(dish && dish.priceCents, 0))
            const lineTotalCents = unitPriceCents * qty
            orderItems.push({
              dishId,
              dishName,
              unitPriceCents,
              qty,
              lineTotalCents,
              piecesPerOrderQtySnapshot: getDishPiecesPerOrderQtySnapshot(dish, toSafeInt),
            })
            totalQty += qty
            totalAmountCents += lineTotalCents
          }
          if (orderItems.length === 0) throwBiz('BAD_REQUEST', 'Empty items')

          const cfgMap = new Map()
          for (const cfg of normalizedSaleConfigs) cfgMap.set(cfg.dishId, { ...cfg })
          const appendedDishIds = []
          const autoExpandedLimits = []
          for (const it of orderItems) {
            let cfgItem = cfgMap.get(it.dishId)
            if (!cfgItem) {
              cfgItem = { dishId: it.dishId, limitQty: 0, soldQty: 0 }
              cfgMap.set(it.dishId, cfgItem)
              appendedDishIds.push(it.dishId)
            }
            const currentLimit = Math.max(0, toSafeInt(cfgItem.limitQty, 0))
            const currentSold = Math.max(0, toSafeInt(cfgItem.soldQty, 0))
            const remain = Math.max(0, currentLimit - currentSold)
            if (it.qty > remain) {
              const grow = it.qty - remain
              cfgItem.limitQty = currentLimit + grow
              autoExpandedLimits.push({
                dishId: it.dishId,
                dishName: it.dishName,
                increaseBy: grow,
                newLimitQty: cfgItem.limitQty,
              })
            }
            cfgItem.soldQty = Math.max(0, toSafeInt(cfgItem.soldQty, 0) + it.qty)
            cfgMap.set(it.dishId, cfgItem)
          }

          const nextConfigs = []
          const pushed = new Set()
          for (const x of normalizedSaleConfigs) {
            const cur = cfgMap.get(x.dishId)
            if (!cur) continue
            nextConfigs.push({ dishId: x.dishId, limitQty: cur.limitQty, soldQty: cur.soldQty })
            pushed.add(x.dishId)
          }
          for (const dishId of appendedDishIds) {
            if (pushed.has(dishId)) continue
            const cur = cfgMap.get(dishId)
            if (!cur) continue
            nextConfigs.push({ dishId, limitQty: cur.limitQty, soldQty: cur.soldQty })
            pushed.add(dishId)
          }

          const dishSnapshotMap = new Map()
          for (const it of orderItems) {
            dishSnapshotMap.set(it.dishId, { name: it.dishName, priceCents: it.unitPriceCents })
          }
          await tx.collection('sales').doc(saleId).update({ data: { updatedAt: db.serverDate() } })
          await replaceSaleItemsForSaleTx(tx, saleId, nextConfigs, { dishSnapshotMap })

          const now = db.serverDate()
          const orderDoc = {
            saleId,
            customerOpenId,
            status: ORDER_STATUS.ACTIVE,
            fulfillmentType,
            deliveryTimeSlotLabelSnapshot,
            acceptDeliverySlot,
            contact: { phone: orderContactPhone },
            addressId: fulfillmentType === 'delivery' ? orderAddressId : null,
            minOrderCentsSnapshot: null,
            payment: {
              method: paymentMethod,
              paidStatus,
            },
            handoffStatus,
            handedOffAt: handoffStatus === HANDOFF_STATUS.DELIVERED ? now : null,
            handedOffByOpenId: handoffStatus === HANDOFF_STATUS.DELIVERED ? (adminOpenId || null) : null,
            remark,
            items: orderItems,
            totals: { qty: totalQty, amountCents: totalAmountCents },
            saleConfigVersionSnapshot: toSafeInt(sale && sale.saleConfigVersion, 0),
            customerLocked: true,
            customerLockedAt: now,
            customerLockedReason: 'ADMIN_MANUAL_CREATE',
            approvedAt: now,
            orderSource: 'ADMIN_MANUAL',
            orderSourceMeta: {
              createdByOpenId: adminOpenId || '',
              createdFrom: 'ADMIN_MANUAL_TOOL',
              customerAction,
            },
            createdAt: now,
            updatedAt: now,
          }

          const addRes = await tx.collection('orders').add({ data: orderDoc })
          const orderId = String((addRes && addRes._id) || '').trim()
          if (!orderId) throwBiz('TX_FAILED', 'Create order failed')

          await tx.collection('order_audit_logs').add({
            data: {
              orderId,
              action: 'ADMIN_MANUAL_CREATE',
              byOpenId: adminOpenId || '',
              at: now,
              detail: {
                customerAction,
                createdManualCustomer: isCreateManual,
                initialPaidStatus: paidStatus,
                initialHandoffStatus: handoffStatus,
                newlyAppendedDishIds: appendedDishIds,
                autoExpandedLimits,
              },
            },
          })

          return {
            orderId,
            customerOpenId,
            createdManualCustomer: isCreateManual,
            newlyAppendedDishIds: appendedDishIds,
            autoExpandedLimits,
          }
        })

        return ok({
          orderId: String((txRes && txRes.orderId) || ''),
          customerOpenId: String((txRes && txRes.customerOpenId) || ''),
          createdManualCustomer: !!(txRes && txRes.createdManualCustomer),
          newlyAppendedDishIds: Array.isArray(txRes && txRes.newlyAppendedDishIds) ? txRes.newlyAppendedDishIds : [],
          autoExpandedLimits: Array.isArray(txRes && txRes.autoExpandedLimits) ? txRes.autoExpandedLimits : [],
          status: ORDER_STATUS.ACTIVE,
        })
      } catch (err) {
        if (err && err.code) return fail(err.code, err.message || 'Create manual order failed', err.detail)
        return fail('TX_FAILED', 'Create manual order failed', String(err && err.message))
      }
    },
  }
}

module.exports = {
  createManualOrderWriteService,
}
