function createCustomerOrderService(deps) {
  const {
    db,
    _,
    ok,
    fail,
    ORDER_STATUS,
    HANDOFF_STATUS,
    toSafeInt,
    pickLatestOrder,
    normalizeCityKey,
    normalizePhone,
    isPhoneValid,
    isAddressValid,
    normalizeStoredAddresses,
    sanitizeProfileNickname,
    normalizeProfilePhone,
    buildDeliveryMinRule,
    getOrCreateAdminConfig,
    getOrderableSale,
    getSaleDocTxHydrated,
    normalizeSaleDishConfigs,
    validateSaleDishConfigs,
    getCustomerDocTx,
    replaceSaleItemsForSaleTx,
    throwBiz,
    isCustomerLocked,
    normalizePaymentMethod,
  } = deps

  function buildLegacyAddressRemovePatch(order) {
    return order && Object.prototype.hasOwnProperty.call(order, 'address') ? { address: _.remove } : {}
  }

  function getExistingPiecesPerOrderQtySnapshot(item) {
    return Math.max(1, toSafeInt(item && item.piecesPerOrderQtySnapshot, 1))
  }

  function getDishPiecesPerOrderQtySnapshot(dish) {
    return Math.max(1, toSafeInt(dish && dish.piecesPerOrderQty, 1))
  }

  return {
    async updateMyOrderItems(event, ctx) {
      const openId = ctx && ctx.openId
      const { orderId } = event
      const incomingItems = Array.isArray(event.items) ? event.items : []
      if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
      try {
        await db.runTransaction(async (tx) => {
          let order
          try {
            const orderGet = await tx.collection('orders').doc(orderId).get()
            order = orderGet.data
          } catch (err) {
            throwBiz('ORDER_NOT_FOUND', 'Order not found')
          }
          if (!order || order.customerOpenId !== openId) throwBiz('FORBIDDEN', 'Forbidden')
          if (order.status !== ORDER_STATUS.ACTIVE && order.status !== ORDER_STATUS.PENDING_REVIEW) {
            throwBiz('ORDER_NOT_EDITABLE', 'Order is not editable')
          }
          if (isCustomerLocked(order)) {
            throwBiz('ORDER_LOCKED_FOR_CUSTOMER', '该订单已由店主确认锁定，顾客不可修改')
          }
          if (!order.saleId) throwBiz('BAD_REQUEST', 'Order sale missing')

          const sale = await getSaleDocTxHydrated(tx, order.saleId)
          if (!sale || sale.status !== 'OPEN') throwBiz('ORDER_LOCKED', 'Sale closed, customer edit disabled')

          const normalizedConfigs = normalizeSaleDishConfigs(sale)
          const configCheck = validateSaleDishConfigs(sale, normalizedConfigs)
          if (!configCheck.ok) throwBiz('SALE_CONFIG_INVALID', configCheck.message)
          const cfgMap = new Map(normalizedConfigs.map((x) => [x.dishId, { ...x }]))
          const oldItems = Array.isArray(order.items) ? order.items : []
          const oldMap = new Map()
          for (const it of oldItems) {
            const dishId = String((it && it.dishId) || '').trim()
            if (!dishId) continue
            oldMap.set(dishId, it)
          }
          if (oldMap.size === 0) throwBiz('BAD_REQUEST', 'Order has no editable items')

          const nextQtyMap = new Map()
          for (const it of incomingItems) {
            const dishId = String((it && it.dishId) || '').trim()
            const qty = Number(it && it.qty)
            if (!dishId || !Number.isFinite(qty) || qty < 0) throwBiz('BAD_REQUEST', 'Invalid items')
            if (!oldMap.has(dishId)) throwBiz('ITEM_NOT_ALLOWED', 'Item not allowed')
            nextQtyMap.set(dishId, Math.floor(qty))
          }
          for (const dishId of oldMap.keys()) {
            if (!nextQtyMap.has(dishId)) nextQtyMap.set(dishId, 0)
          }

          if (order.status === ORDER_STATUS.ACTIVE) {
            const outOfStock = []
            for (const [dishId, nextQty] of nextQtyMap.entries()) {
              const oldQty = toSafeInt(oldMap.get(dishId) && oldMap.get(dishId).qty, 0)
              const delta = nextQty - oldQty
              if (delta <= 0) continue
              const cfgItem = cfgMap.get(dishId)
              if (!cfgItem) throwBiz('ITEM_NOT_ALLOWED', 'Item not allowed')
              const remain = Math.max(0, toSafeInt(cfgItem.limitQty, 0) - toSafeInt(cfgItem.soldQty, 0))
              if (delta > remain) {
                outOfStock.push({
                  dishId,
                  dishName: String((oldMap.get(dishId) && oldMap.get(dishId).dishName) || ''),
                  remainingQty: remain,
                  requiredQty: delta,
                })
              }
            }
            if (outOfStock.length > 0) throwBiz('OUT_OF_STOCK', 'Out of stock', { items: outOfStock })

            for (const [dishId, nextQty] of nextQtyMap.entries()) {
              const oldQty = toSafeInt(oldMap.get(dishId) && oldMap.get(dishId).qty, 0)
              const delta = nextQty - oldQty
              if (delta === 0) continue
              const cfgItem = cfgMap.get(dishId)
              if (!cfgItem) continue
              cfgItem.soldQty = Math.max(0, toSafeInt(cfgItem.soldQty, 0) + delta)
              cfgMap.set(dishId, cfgItem)
            }
          }

          const nextItems = []
          let totalQty = 0
          let totalAmountCents = 0
          for (const [dishId, nextQty] of nextQtyMap.entries()) {
            if (nextQty <= 0) continue
            const old = oldMap.get(dishId)
            const unitPriceCents = toSafeInt(old && old.unitPriceCents, 0)
            const dishName = String((old && old.dishName) || '')
            if (!dishName) throwBiz('BAD_REQUEST', 'Invalid order item')
            const lineTotalCents = unitPriceCents * nextQty
            totalQty += nextQty
            totalAmountCents += lineTotalCents
            nextItems.push({
              dishId,
              dishName,
              unitPriceCents,
              qty: nextQty,
              lineTotalCents,
              piecesPerOrderQtySnapshot: getExistingPiecesPerOrderQtySnapshot(old),
            })
          }
          if (nextItems.length === 0) throwBiz('BAD_REQUEST', 'Order cannot be empty, cancel it instead')

          if (order.status === ORDER_STATUS.ACTIVE) {
            const updatedConfigs = normalizedConfigs.map((x) => {
              const cur = cfgMap.get(x.dishId)
              return cur ? { dishId: x.dishId, limitQty: cur.limitQty, soldQty: cur.soldQty } : x
            })
            await tx.collection('sales').doc(order.saleId).update({
              data: {
                updatedAt: db.serverDate(),
              },
            })
            await replaceSaleItemsForSaleTx(tx, order.saleId, updatedConfigs)
          }

          const now = db.serverDate()
          await tx.collection('orders').doc(orderId).update({
            data: {
              items: nextItems,
              totals: { qty: totalQty, amountCents: totalAmountCents },
              saleConfigVersionSnapshot:
                order.status === ORDER_STATUS.ACTIVE ? toSafeInt(sale.saleConfigVersion, 0) : toSafeInt(order.saleConfigVersionSnapshot, 0),
              ...buildLegacyAddressRemovePatch(order),
              updatedAt: now,
            },
          })
          await tx.collection('order_audit_logs').add({
            data: {
              orderId,
              action: order.status === ORDER_STATUS.ACTIVE ? 'CUSTOMER_UPDATE_ITEMS' : 'CUSTOMER_UPDATE_PENDING_ITEMS',
              byOpenId: openId,
              at: now,
            },
          })
        })
      } catch (err) {
        if (err && err.code) return fail(err.code, err.message || 'Request failed', err.detail)
        return fail('TX_FAILED', 'Update order failed', String(err && err.message))
      }
      return ok({})
    },

    async cancelMyOrder(event, ctx) {
      const openId = ctx && ctx.openId
      const { orderId } = event
      if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
      try {
        await db.runTransaction(async (tx) => {
          let order
          try {
            const orderGet = await tx.collection('orders').doc(orderId).get()
            order = orderGet.data
          } catch (err) {
            throwBiz('ORDER_NOT_FOUND', 'Order not found')
          }
          if (!order || order.customerOpenId !== openId) throwBiz('FORBIDDEN', 'Forbidden')
          if (order.status === ORDER_STATUS.CANCELLED || order.status === ORDER_STATUS.REJECTED) return
          if (order.status !== ORDER_STATUS.ACTIVE && order.status !== ORDER_STATUS.PENDING_REVIEW) {
            throwBiz('ORDER_NOT_EDITABLE', 'Order is not editable')
          }
          if (isCustomerLocked(order)) {
            throwBiz('ORDER_LOCKED_FOR_CUSTOMER', '该订单已由店主确认锁定，顾客不可取消')
          }
          if (!order.saleId) throwBiz('BAD_REQUEST', 'Order sale missing')

          const sale = await getSaleDocTxHydrated(tx, order.saleId)
          if (!sale || sale.status !== 'OPEN') throwBiz('ORDER_LOCKED', 'Sale closed, customer cancel disabled')

          if (order.status === ORDER_STATUS.ACTIVE) {
            const normalizedConfigs = normalizeSaleDishConfigs(sale)
            const configCheck = validateSaleDishConfigs(sale, normalizedConfigs)
            if (!configCheck.ok) throwBiz('SALE_CONFIG_INVALID', configCheck.message)
            const cfgMap = new Map(normalizedConfigs.map((x) => [x.dishId, { ...x }]))
            for (const it of order.items || []) {
              const dishId = String((it && it.dishId) || '').trim()
              const qty = toSafeInt(it && it.qty, 0)
              if (!dishId || qty <= 0) continue
              const cfgItem = cfgMap.get(dishId)
              if (!cfgItem) continue
              cfgItem.soldQty = Math.max(0, toSafeInt(cfgItem.soldQty, 0) - qty)
              cfgMap.set(dishId, cfgItem)
            }
            const updatedConfigs = normalizedConfigs.map((x) => {
              const cur = cfgMap.get(x.dishId)
              return cur ? { dishId: x.dishId, limitQty: cur.limitQty, soldQty: cur.soldQty } : x
            })
            await tx.collection('sales').doc(order.saleId).update({
              data: { updatedAt: db.serverDate() },
            })
            await replaceSaleItemsForSaleTx(tx, order.saleId, updatedConfigs)
          }

          const now = db.serverDate()
          await tx.collection('orders').doc(orderId).update({
            data: {
              status: ORDER_STATUS.CANCELLED,
              cancelledAt: now,
              cancelledByOpenId: openId,
              ...buildLegacyAddressRemovePatch(order),
              updatedAt: now,
            },
          })
          await tx.collection('order_audit_logs').add({
            data: {
              orderId,
              action: 'CUSTOMER_CANCEL',
              byOpenId: openId,
              at: now,
            },
          })
        })
      } catch (err) {
        if (err && err.code) return fail(err.code, err.message || 'Request failed', err.detail)
        return fail('TX_FAILED', 'Cancel order failed', String(err && err.message))
      }
      return ok({})
    },

    async createOrder(event, ctx) {
      const openId = ctx && ctx.openId
      const sale = await getOrderableSale()
      if (!sale) return fail('NOT_OPEN', 'Not open for ordering')
      const saleId = event.saleId
      if (!saleId || saleId !== sale._id) return fail('NOT_OPEN', 'Not open for ordering')

      const requestedFulfillmentType = event.fulfillmentType
      if (requestedFulfillmentType !== 'delivery' && requestedFulfillmentType !== 'pickup') {
        return fail('BAD_REQUEST', 'Invalid fulfillmentType')
      }

      const requestedAddressId = String(event.addressId || '').trim()
      const requestedAcceptDeliverySlot = !!event.acceptDeliverySlot
      const requestedPhone = normalizePhone(event.phone)
      if (requestedFulfillmentType === 'delivery' && !requestedAddressId) {
        return fail('BAD_REQUEST', '缺少 addressId')
      }

      const items = Array.isArray(event.items) ? event.items : []
      if (items.length === 0) return fail('BAD_REQUEST', 'Empty items')

      const incomingQtyById = new Map()
      for (const it of items) {
        const dishId = it && it.dishId
        const qty = Number(it && it.qty)
        if (!dishId || !Number.isFinite(qty) || qty <= 0) continue
        incomingQtyById.set(dishId, (incomingQtyById.get(dishId) || 0) + Math.floor(qty))
      }
      if (incomingQtyById.size === 0) return fail('BAD_REQUEST', 'Empty items')
      const payment = event.payment || {}
      const paymentMethod = normalizePaymentMethod(payment.method)
      if (!paymentMethod) return fail('BAD_REQUEST', 'Invalid paymentMethod')
      const adminConfig = await getOrCreateAdminConfig()
      const deliveryRule = buildDeliveryMinRule(adminConfig)
      try {
        const txRes = await db.runTransaction(async (tx) => {
          const saleDoc = await getSaleDocTxHydrated(tx, sale._id)
          if (!saleDoc || saleDoc.status !== 'OPEN') throwBiz('NOT_OPEN', 'Not open for ordering')

          const normalizedSaleConfigsForAllowed = normalizeSaleDishConfigs(saleDoc)
          const configCheckAllowed = validateSaleDishConfigs(saleDoc, normalizedSaleConfigsForAllowed)
          if (!configCheckAllowed.ok) throwBiz('SALE_CONFIG_INVALID', configCheckAllowed.message)
          const allowed = new Set(normalizedSaleConfigsForAllowed.map((x) => x.dishId))
          for (const dishId of incomingQtyById.keys()) {
            if (!allowed.has(dishId)) throwBiz('ITEM_NOT_ALLOWED', 'Item not allowed')
          }

          let existing = null
          try {
            const pendingRes = await tx
              .collection('orders')
              .where({
                customerOpenId: openId,
                status: ORDER_STATUS.PENDING_REVIEW,
              })
              .limit(20)
              .get()
            existing = pickLatestOrder((pendingRes && pendingRes.data) || [])
            if (!existing) {
              const activeRes = await tx
                .collection('orders')
                .where({
                  saleId: saleDoc._id,
                  customerOpenId: openId,
                  status: ORDER_STATUS.ACTIVE,
                })
                .limit(20)
                .get()
              existing = pickLatestOrder((activeRes && activeRes.data) || [])
            }
          } catch (err) {
            existing = null
          }
          const hasEditableExisting = !!existing
          if (hasEditableExisting && isCustomerLocked(existing)) {
            throwBiz('ORDER_LOCKED_FOR_CUSTOMER', '该订单已由店主确认锁定，顾客不可修改')
          }
          let fulfillmentType = requestedFulfillmentType
          let addressId = requestedAddressId
          let acceptDeliverySlot = requestedAcceptDeliverySlot
          if (hasEditableExisting) {
            const existingFulfillmentType = String(existing.fulfillmentType || '').trim()
            if (existingFulfillmentType && requestedFulfillmentType !== existingFulfillmentType) {
              throwBiz('FULFILLMENT_LOCKED', '已有订单不可修改交货方式')
            }
            if (existingFulfillmentType) fulfillmentType = existingFulfillmentType
            if (fulfillmentType === 'delivery') {
              if (!requestedAddressId) throwBiz('BAD_REQUEST', '缺少 addressId')
              const existingAddressId = String(existing.addressId || '').trim()
              if (existingAddressId && requestedAddressId !== existingAddressId) {
                throwBiz('ADDRESS_LOCKED', '已有订单不可修改地址')
              }
              addressId = requestedAddressId
            } else {
              addressId = ''
            }
          }
          if (fulfillmentType === 'delivery') {
            if (!addressId) throwBiz('BAD_REQUEST', '请选择地址')
            if (!hasEditableExisting && !acceptDeliverySlot) {
              throwBiz('DELIVERY_SLOT_NOT_ACCEPTED', 'Delivery slot not accepted')
            }
            if (!String(saleDoc.deliveryTimeSlotLabel || '').trim()) {
              throwBiz('NOT_OPEN', 'Delivery slot not set')
            }
            acceptDeliverySlot = true
          } else {
            addressId = ''
            acceptDeliverySlot = false
          }

          const existingQtyById = new Map()
          const existingStockedQtyById = new Map()
          const existingItemById = new Map()
          if (hasEditableExisting && Array.isArray(existing.items)) {
            for (const oldItem of existing.items) {
              const dishId = String((oldItem && oldItem.dishId) || '').trim()
              const qty = toSafeInt(oldItem && oldItem.qty, 0)
              if (!dishId || qty <= 0) continue
              existingQtyById.set(dishId, qty)
              existingItemById.set(dishId, oldItem)
              if (existing.status === ORDER_STATUS.ACTIVE) existingStockedQtyById.set(dishId, qty)
            }
          }

          const mergedQtyById = new Map(existingQtyById)
          for (const [dishId, qty] of incomingQtyById.entries()) {
            mergedQtyById.set(dishId, (mergedQtyById.get(dishId) || 0) + qty)
          }
          if (mergedQtyById.size === 0) throwBiz('BAD_REQUEST', 'Empty items')
          const outOfCurrentSaleItemIds = []
          if (hasEditableExisting && existing.status === ORDER_STATUS.PENDING_REVIEW) {
            for (const dishId of existingQtyById.keys()) {
              if (!allowed.has(dishId)) outOfCurrentSaleItemIds.push(dishId)
            }
          }

          const mergedDishIds = Array.from(mergedQtyById.keys())
          const dishMap = new Map()
          for (let i = 0; i < mergedDishIds.length; i += 10) {
            const chunk = mergedDishIds.slice(i, i + 10)
            const r = await tx.collection('dishes').where({ _id: _.in(chunk) }).get()
            for (const d of r.data || []) dishMap.set(d._id, d)
          }
          for (const dishId of incomingQtyById.keys()) {
            const d = dishMap.get(dishId)
            if (!d || !d.isActive) throwBiz('ITEM_NOT_ALLOWED', 'Item not allowed')
          }

          const orderItems = []
          let totalQty = 0
          let totalAmountCents = 0
          for (const dishId of mergedDishIds) {
            const qty = toSafeInt(mergedQtyById.get(dishId), 0)
            if (qty <= 0) continue
            const dish = dishMap.get(dishId)
            const oldItem = existingItemById.get(dishId) || null
            const unitPriceCents = dish && dish.isActive ? toSafeInt(dish.priceCents, 0) : toSafeInt(oldItem && oldItem.unitPriceCents, 0)
            const dishName = dish ? String(dish.name || '') : String((oldItem && oldItem.dishName) || '')
            if (!dishName) throwBiz('ITEM_NOT_ALLOWED', 'Item not allowed')
            const lineTotalCents = unitPriceCents * qty
            totalQty += qty
            totalAmountCents += lineTotalCents
            orderItems.push({
              dishId,
              dishName,
              unitPriceCents,
              qty,
              lineTotalCents,
              piecesPerOrderQtySnapshot: oldItem
                ? getExistingPiecesPerOrderQtySnapshot(oldItem)
                : getDishPiecesPerOrderQtySnapshot(dish),
            })
          }
          if (orderItems.length === 0) throwBiz('BAD_REQUEST', 'Empty items')

          let addressSnapshot = null
          let orderAddressId = ''
          let orderPhone = ''
          let pendingReason = ''
          let pendingDetail = null
          let minOrderCentsForCity = null
          let customer = null
          let customerNickname = ''
          let customerProfilePhone = ''
          customer = await getCustomerDocTx(tx, openId)
          customerNickname = sanitizeProfileNickname(customer && customer.nickname)
          customerProfilePhone = normalizeProfilePhone(customer && customer.profilePhone)
          if (!customerNickname) throwBiz('PROFILE_INCOMPLETE', '请先完善昵称')
          const addresses = normalizeStoredAddresses(customer && customer.addresses)
          const picked = addressId ? addresses.find((x) => x.id === addressId) || null : null

          if (fulfillmentType === 'delivery') {
            if (!picked) throwBiz('ADDRESS_NOT_FOUND', '请选择有效地址')
            addressSnapshot = {
              label: String(picked.label || '').trim(),
              line1: String(picked.line1 || '').trim(),
              line2: String(picked.line2 || '').trim(),
              postalCode: String(picked.postalCode || '').trim(),
              city: String(picked.city || '').trim(),
              phone: normalizePhone(picked.phone || ''),
              country: 'FR',
            }
            if (!isAddressValid(addressSnapshot)) throwBiz('INVALID_ADDRESS', 'Invalid address')
            orderAddressId = addressId
            orderPhone = normalizePhone(addressSnapshot.phone)
            if (!isPhoneValid(orderPhone)) throwBiz('INVALID_PHONE', 'Invalid phone')

            const cityKey = normalizeCityKey(addressSnapshot.city)
            if (deliveryRule.cityMinMap.has(cityKey)) {
              minOrderCentsForCity = toSafeInt(deliveryRule.cityMinMap.get(cityKey), 0)
            } else if (deliveryRule.defaultMinOrderCents) {
              minOrderCentsForCity = deliveryRule.defaultMinOrderCents
            }
            if (!minOrderCentsForCity) {
              pendingReason = 'CITY_RULE_MISSING'
              pendingDetail = {
                city: addressSnapshot.city,
                postalCode: addressSnapshot.postalCode,
              }
            } else if (totalAmountCents < minOrderCentsForCity) {
              throwBiz('MIN_ORDER_NOT_MET', '未达到该地址起送价', {
                city: addressSnapshot.city,
                totalAmountCents,
                minOrderCents: minOrderCentsForCity,
              })
            }
          } else {
            orderAddressId = ''
            addressSnapshot = null
            if (requestedPhone) {
              if (!isPhoneValid(requestedPhone)) throwBiz('INVALID_PHONE', 'Invalid phone')
              orderPhone = requestedPhone
            } else if (customerProfilePhone && isPhoneValid(customerProfilePhone)) {
              orderPhone = customerProfilePhone
            } else if (existing && existing.contact && isPhoneValid(existing.contact.phone)) {
              orderPhone = normalizePhone(existing.contact.phone)
            } else {
              orderPhone = ''
            }
            if (!isPhoneValid(orderPhone)) throwBiz('INVALID_PHONE', 'Invalid phone')
          }

          if (!pendingReason && outOfCurrentSaleItemIds.length > 0) {
            pendingReason = 'ITEM_NOT_IN_CURRENT_SALE'
            pendingDetail = {
              dishIds: outOfCurrentSaleItemIds,
            }
          }
          const nextStatus = pendingReason ? ORDER_STATUS.PENDING_REVIEW : ORDER_STATUS.ACTIVE
          if (nextStatus === ORDER_STATUS.ACTIVE || (existing && existing.status === ORDER_STATUS.ACTIVE)) {
            const normalizedConfigs = normalizedSaleConfigsForAllowed
            const configCheck = configCheckAllowed
            if (!configCheck.ok) throwBiz('SALE_CONFIG_INVALID', configCheck.message)
            const cfgMap = new Map(normalizedConfigs.map((x) => [x.dishId, { ...x }]))
            const stockDishIdSet = new Set()
            for (const dishId of mergedDishIds) stockDishIdSet.add(dishId)
            for (const dishId of existingStockedQtyById.keys()) stockDishIdSet.add(dishId)
            const stockDishIds = Array.from(stockDishIdSet)
            const outOfStock = []
            for (const dishId of stockDishIds) {
              const newQty = nextStatus === ORDER_STATUS.ACTIVE ? toSafeInt(mergedQtyById.get(dishId), 0) : 0
              const oldStockedQty = toSafeInt(existingStockedQtyById.get(dishId), 0)
              const delta = newQty - oldStockedQty
              if (delta <= 0) continue
              const cfgItem = cfgMap.get(dishId)
              if (!cfgItem) throwBiz('ITEM_NOT_ALLOWED', 'Item not allowed')
              const remain = Math.max(0, toSafeInt(cfgItem.limitQty, 0) - toSafeInt(cfgItem.soldQty, 0))
              if (delta > remain) {
                outOfStock.push({
                  dishId,
                  dishName: (dishMap.get(dishId) && dishMap.get(dishId).name) || '',
                  remainingQty: remain,
                  requiredQty: delta,
                })
              }
            }
            if (outOfStock.length > 0) throwBiz('OUT_OF_STOCK', 'Out of stock', { items: outOfStock })

            let stockChanged = false
            for (const dishId of stockDishIds) {
              const newQty = nextStatus === ORDER_STATUS.ACTIVE ? toSafeInt(mergedQtyById.get(dishId), 0) : 0
              const oldStockedQty = toSafeInt(existingStockedQtyById.get(dishId), 0)
              const delta = newQty - oldStockedQty
              if (delta === 0) continue
              const cfgItem = cfgMap.get(dishId)
              if (!cfgItem) throwBiz('ITEM_NOT_ALLOWED', 'Item not allowed')
              cfgItem.soldQty = Math.max(0, toSafeInt(cfgItem.soldQty, 0) + delta)
              cfgMap.set(dishId, cfgItem)
              stockChanged = true
            }
            if (stockChanged) {
              const updatedConfigs = normalizedConfigs.map((x) => {
                const cur = cfgMap.get(x.dishId)
                return cur ? { dishId: x.dishId, limitQty: cur.limitQty, soldQty: cur.soldQty } : x
              })
              await tx.collection('sales').doc(saleDoc._id).update({
                data: { updatedAt: db.serverDate() },
              })
              await replaceSaleItemsForSaleTx(tx, saleDoc._id, updatedConfigs)
            }
          }

          const paidStatus = String((existing && existing.payment && existing.payment.paidStatus) || '') === 'PAID' ? 'PAID' : 'UNPAID'
          const now = db.serverDate()
          if (fulfillmentType === 'delivery' && !orderAddressId) throwBiz('BAD_REQUEST', '请选择地址')
          const doc = {
            saleId: saleDoc._id,
            customerOpenId: openId,
            status: nextStatus,
            fulfillmentType,
            deliveryTimeSlotLabelSnapshot: fulfillmentType === 'delivery' ? String(saleDoc.deliveryTimeSlotLabel || '').trim() : null,
            acceptDeliverySlot,
            contact: { phone: orderPhone },
            addressId: fulfillmentType === 'delivery' ? orderAddressId : null,
            minOrderCentsSnapshot: fulfillmentType === 'delivery' ? minOrderCentsForCity || null : null,
            payment: { method: paymentMethod, paidStatus },
            handoffStatus: 'PENDING',
            handedOffAt: null,
            handedOffByOpenId: null,
            remark: String(event.remark || '').trim(),
            items: orderItems,
            totals: { qty: totalQty, amountCents: totalAmountCents },
            saleConfigVersionSnapshot: nextStatus === ORDER_STATUS.ACTIVE ? toSafeInt(saleDoc.saleConfigVersion, 0) : 0,
            customerLocked: false,
            updatedAt: now,
          }
          const auditAction =
            nextStatus === ORDER_STATUS.PENDING_REVIEW
              ? existing
                ? 'UPDATE_PENDING'
                : 'CREATE_PENDING'
              : existing
                ? 'UPDATE'
                : 'CREATE'
          let currentOrderId = String((existing && existing._id) || '').trim()
          if (existing) {
            const updateData = {
              ...doc,
              ...buildLegacyAddressRemovePatch(existing),
              cancelledAt: _.remove,
              cancelledByOpenId: _.remove,
              rejectedAt: _.remove,
              rejectedByOpenId: _.remove,
              rejectedReason: _.remove,
              approvedAt: nextStatus === ORDER_STATUS.ACTIVE ? now : _.remove,
              customerLockedAt: _.remove,
              customerLockedReason: _.remove,
            }
            if (nextStatus === ORDER_STATUS.PENDING_REVIEW) {
              updateData.pendingReason = pendingReason
              updateData.pendingDetail = pendingDetail
              updateData.pendingAt =
                existing.status === ORDER_STATUS.PENDING_REVIEW && existing.pendingAt ? existing.pendingAt : now
            } else {
              updateData.pendingReason = _.remove
              updateData.pendingDetail = _.remove
              updateData.pendingAt = _.remove
            }
            await tx.collection('orders').doc(currentOrderId).update({
              data: updateData,
            })
          } else {
            const setDoc = {
              ...doc,
              createdAt: now,
            }
            if (nextStatus === ORDER_STATUS.PENDING_REVIEW) {
              setDoc.pendingReason = pendingReason
              setDoc.pendingDetail = pendingDetail
              setDoc.pendingAt = now
            } else {
              setDoc.approvedAt = now
            }
            const addRes = await tx.collection('orders').add({
              data: setDoc,
            })
            currentOrderId = String((addRes && addRes._id) || '').trim()
            if (!currentOrderId) throwBiz('TX_FAILED', 'Create order failed')
          }

          const shouldUpdateProfilePhone =
            fulfillmentType === 'pickup' &&
            requestedPhone &&
            isPhoneValid(requestedPhone) &&
            requestedPhone !== customerProfilePhone &&
            !!customer
          if (shouldUpdateProfilePhone) {
            await tx.collection('customer_profiles').doc(openId).update({
              data: {
                profilePhone: requestedPhone,
                updatedAt: now,
              },
            })
          }

          await tx.collection('order_audit_logs').add({
            data: {
              orderId: currentOrderId,
              action: auditAction,
              byOpenId: openId,
              at: now,
            },
          })
          return { orderId: currentOrderId, mode: auditAction, status: nextStatus }
        })
        return ok({
          orderId: txRes && txRes.orderId ? txRes.orderId : '',
          mode: txRes && txRes.mode ? txRes.mode : 'UPDATE',
          status: txRes && txRes.status ? txRes.status : ORDER_STATUS.ACTIVE,
        })
      } catch (err) {
        if (err && err.code) return fail(err.code, err.message || 'Request failed', err.detail)
        return fail('TX_FAILED', 'Create order failed', String(err && err.message))
      }
    },
  }
}

module.exports = {
  createCustomerOrderService,
}
