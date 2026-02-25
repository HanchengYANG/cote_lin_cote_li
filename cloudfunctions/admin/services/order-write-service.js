function createOrderWriteService(deps) {
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
    dishConfigMap,
    toSafeInt,
    normalizeOrderItems,
    replaceSaleItemsForSaleTx,
    parseAndValidateDeliverySlot,
    normalizePhone,
    normalizeAddressPayload,
    normalizeStoredAddresses,
    isPhoneValid,
    extractOrderAddressSnapshot,
  } = deps

  return {
    async listPendingOrders(event) {
      const saleId = String(event.saleId || '').trim()
      const where = { status: ORDER_STATUS.PENDING_REVIEW }
      if (saleId) where.saleId = saleId
      const orders = await getAllByPaging((skip, limit) => db.collection('orders').where(where).skip(skip).limit(limit), {
        pageSize: 100,
      })
      return ok({ orders })
    },

    async approvePendingOrderNow(event, ctx) {
      const openId = ctx && ctx.openId
      const orderId = String(event.orderId || '').trim()
      if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
      const slotLabelInput = String(event.deliveryTimeSlotLabel || '').trim()
      try {
        await db.runTransaction(async (tx) => {
          let order
          try {
            const got = await tx.collection('orders').doc(orderId).get()
            order = got.data
          } catch (err) {
            throwBiz('ORDER_NOT_FOUND', 'Order not found')
          }
          if (!order) throwBiz('ORDER_NOT_FOUND', 'Order not found')
          if (order.status !== ORDER_STATUS.PENDING_REVIEW) throwBiz('ORDER_NOT_PENDING', 'Order is not pending')
          if (!order.saleId) throwBiz('BAD_REQUEST', 'Order sale missing')

          const sale = await getSaleTx(tx, order.saleId)
          const saleStatus = String((sale && sale.status) || '').trim()
          if (!sale || (saleStatus !== 'OPEN' && saleStatus !== 'CLOSED' && saleStatus !== 'FULFILLING')) {
            throwBiz('ORDER_LOCKED', '仅开单中/已截单/配送中可立即确认待确认订单')
          }

          const normalizedConfigs = normalizeDishConfigs(sale.dishConfigs)
          const cfgMap = dishConfigMap(normalizedConfigs)
          const orderItems = normalizeOrderItems(order.items)
          if (orderItems.length === 0) throwBiz('BAD_REQUEST', 'Order has no items')
          const appendedDishIds = []
          for (const it of orderItems) {
            let cfgItem = cfgMap.get(it.dishId)
            if (!cfgItem) {
              cfgItem = { dishId: it.dishId, limitQty: 0, soldQty: 0 }
              cfgMap.set(it.dishId, cfgItem)
              appendedDishIds.push(it.dishId)
            }
            const nextSoldQty = Math.max(0, toSafeInt(cfgItem.soldQty, 0) + it.qty)
            const nextLimitQty = Math.max(0, toSafeInt(cfgItem.limitQty, 0), nextSoldQty)
            cfgItem.soldQty = nextSoldQty
            cfgItem.limitQty = nextLimitQty
            cfgMap.set(it.dishId, cfgItem)
          }
          const nextConfigs = []
          const pushed = new Set()
          for (const x of normalizedConfigs) {
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
          await tx.collection('sales').doc(order.saleId).update({
            data: {
              updatedAt: db.serverDate(),
            },
          })
          await replaceSaleItemsForSaleTx(tx, order.saleId, nextConfigs)

          let deliveryTimeSlotLabelSnapshot = order.deliveryTimeSlotLabelSnapshot || null
          if (order.fulfillmentType === 'delivery') {
            deliveryTimeSlotLabelSnapshot = slotLabelInput || String(sale.deliveryTimeSlotLabel || '').trim()
            if (!deliveryTimeSlotLabelSnapshot) throwBiz('BAD_REQUEST', 'Missing delivery slot')
          }

          const now = db.serverDate()
          await tx.collection('orders').doc(orderId).update({
            data: {
              status: ORDER_STATUS.ACTIVE,
              handoffStatus: HANDOFF_STATUS.PENDING,
              handedOffAt: _.remove,
              handedOffByOpenId: _.remove,
              deliveryTimeSlotLabelSnapshot,
              pendingReason: _.remove,
              pendingDetail: _.remove,
              pendingAt: _.remove,
              approvedAt: now,
              customerLocked: true,
              customerLockedAt: now,
              customerLockedReason: 'ADMIN_APPROVED_PENDING',
              saleConfigVersionSnapshot: toSafeInt(sale.saleConfigVersion, 0),
              updatedAt: now,
            },
          })
          await tx.collection('order_audit_logs').add({
            data: {
              orderId,
              action: 'ADMIN_APPROVE_PENDING',
              byOpenId: openId,
              at: now,
            },
          })
        })
      } catch (err) {
        if (err && err.code) return fail(err.code, err.message || 'Approve failed', err.detail)
        return fail('TX_FAILED', 'Approve failed', String(err && err.message))
      }
      return ok({})
    },

    async rejectPendingOrder(event, ctx) {
      const openId = ctx && ctx.openId
      const orderId = String(event.orderId || '').trim()
      if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
      const rejectedReason = String(event.rejectedReason || '').trim().slice(0, 200)
      try {
        await db.runTransaction(async (tx) => {
          let order = null
          try {
            const got = await tx.collection('orders').doc(orderId).get()
            order = got.data
          } catch (err) {
            order = null
          }
          if (!order) throwBiz('ORDER_NOT_FOUND', 'Order not found')
          if (order.status !== ORDER_STATUS.PENDING_REVIEW) throwBiz('ORDER_NOT_PENDING', 'Order is not pending')

          const now = db.serverDate()
          await tx.collection('orders').doc(orderId).update({
            data: {
              status: ORDER_STATUS.REJECTED,
              rejectedReason,
              rejectedAt: now,
              rejectedByOpenId: openId,
              pendingReason: _.remove,
              pendingDetail: _.remove,
              pendingAt: _.remove,
              updatedAt: now,
            },
          })
          await tx.collection('order_audit_logs').add({
            data: {
              orderId,
              action: 'ADMIN_REJECT_PENDING',
              byOpenId: openId,
              at: now,
            },
          })
        })
      } catch (err) {
        if (err && err.code) return fail(err.code, err.message || 'Reject failed', err.detail)
        return fail('TX_FAILED', 'Reject failed', String(err && err.message))
      }
      return ok({})
    },

    async updateOrderDeliverySlot(event, ctx) {
      const openId = ctx && ctx.openId
      const orderId = String(event.orderId || '').trim()
      if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
      let slotLabel = String(event.deliveryTimeSlotLabel || '').trim()
      if (!slotLabel) {
        const slot = parseAndValidateDeliverySlot(event)
        if (!slot.ok) return fail('BAD_REQUEST', slot.message)
        slotLabel = slot.deliveryTimeSlotLabel
      }
      try {
        const r = await db.collection('orders').doc(orderId).get()
        const order = r.data
        if (!order) return fail('ORDER_NOT_FOUND', 'Order not found')
        if (order.fulfillmentType !== 'delivery') return fail('BAD_REQUEST', 'Only delivery order can update slot')
        if (order.status !== ORDER_STATUS.ACTIVE && order.status !== ORDER_STATUS.PENDING_REVIEW) {
          return fail('ORDER_NOT_EDITABLE', 'Order is not editable')
        }
        const now = db.serverDate()
        await db.collection('orders').doc(orderId).update({
          data: {
            deliveryTimeSlotLabelSnapshot: slotLabel,
            updatedAt: now,
          },
        })
        await db.collection('order_audit_logs').add({
          data: {
            orderId,
            action: 'ADMIN_UPDATE_SLOT',
            byOpenId: openId,
            at: now,
          },
        })
      } catch (err) {
        return fail('TX_FAILED', 'Update delivery slot failed', String(err && err.message))
      }
      return ok({})
    },

    async updateOrderFulfillment(event, ctx) {
      const openId = ctx && ctx.openId
      const orderId = String(event.orderId || '').trim()
      const fulfillmentType = String(event.fulfillmentType || '').trim()
      const requestedAddressId = String(event.addressId || '').trim()
      const hasManualAddressInput = !!(event && event.address)
      const hasPhoneInput = Object.prototype.hasOwnProperty.call(event || {}, 'phone')
      const requestedPhone = hasPhoneInput ? normalizePhone(event.phone) : ''
      const requestedManualAddress = event && event.address ? normalizeAddressPayload(event.address) : null
      if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
      if (fulfillmentType !== 'delivery' && fulfillmentType !== 'pickup') return fail('BAD_REQUEST', 'Invalid fulfillmentType')
      if (hasManualAddressInput && !requestedManualAddress) return fail('INVALID_ADDRESS', '手动地址格式不正确')
      let slotLabel = String(event.deliveryTimeSlotLabel || '').trim()
      if (!slotLabel && fulfillmentType === 'delivery') {
        const slot = parseAndValidateDeliverySlot(event)
        if (slot.ok) slotLabel = slot.deliveryTimeSlotLabel
      }
      try {
        const r = await db.collection('orders').doc(orderId).get()
        const order = r.data
        if (!order) return fail('ORDER_NOT_FOUND', 'Order not found')
        if (order.status !== ORDER_STATUS.ACTIVE && order.status !== ORDER_STATUS.PENDING_REVIEW) {
          return fail('ORDER_NOT_EDITABLE', 'Order is not editable')
        }

        let customerAddresses = []
        if (order.customerOpenId) {
          try {
            const r2 = await db.collection('customer_addresses').where({ customerOpenId: order.customerOpenId }).get()
            customerAddresses = normalizeStoredAddresses((r2 && r2.data) || [])
          } catch (err) {
            customerAddresses = []
          }
        }

        const currentPhone = normalizePhone(order.contact && order.contact.phone)
        const nextData = {
          fulfillmentType,
          // Use _.set to replace the whole object; direct nested merge fails when contact/address is null.
          contact: _.set({
            phone: hasPhoneInput ? requestedPhone : currentPhone,
          }),
          updatedAt: db.serverDate(),
        }
        let addressSource = 'unchanged'

        if (fulfillmentType === 'delivery') {
          let nextAddress = null
          let nextAddressId = null

          const selectedSaved = requestedAddressId ? customerAddresses.find((x) => x.id === requestedAddressId) || null : null
          if (requestedAddressId && !selectedSaved) return fail('BAD_REQUEST', '所选客户地址不存在')
          if (selectedSaved) {
            nextAddress = {
              label: selectedSaved.label,
              line1: selectedSaved.line1,
              line2: selectedSaved.line2,
              postalCode: selectedSaved.postalCode,
              city: selectedSaved.city,
              country: 'FR',
            }
            nextAddressId = selectedSaved.id
            addressSource = 'addressId'
            if (!nextData.contact.phone && isPhoneValid(selectedSaved.phone)) nextData.contact.phone = selectedSaved.phone
          } else if (requestedManualAddress) {
            nextAddress = {
              label: requestedManualAddress.label,
              line1: requestedManualAddress.line1,
              line2: requestedManualAddress.line2,
              postalCode: requestedManualAddress.postalCode,
              city: requestedManualAddress.city,
              country: 'FR',
            }
            nextAddressId = null
            addressSource = 'manual'
          } else {
            const existingAddress = extractOrderAddressSnapshot(order.address)
            if (existingAddress) {
              nextAddress = existingAddress
              const oldAddressId = String(order.addressId || '').trim()
              nextAddressId = oldAddressId || null
            }
          }
          if (!nextAddress) return fail('BAD_REQUEST', '配送订单缺少有效地址')
          if (!isPhoneValid(nextData.contact.phone)) return fail('INVALID_PHONE', '请填写有效电话')
          nextData.address = _.set(nextAddress)
          nextData.addressId = nextAddressId

          if (!slotLabel) slotLabel = String(order.deliveryTimeSlotLabelSnapshot || '').trim()
          if (!slotLabel && order.saleId) {
            try {
              const saleRes = await db.collection('sales').doc(order.saleId).get()
              const sale = saleRes.data
              slotLabel = String((sale && sale.deliveryTimeSlotLabel) || '').trim()
            } catch (err) {
              slotLabel = ''
            }
          }
          if (!slotLabel) return fail('BAD_REQUEST', '配送需要时间段')
          nextData.deliveryTimeSlotLabelSnapshot = slotLabel
          nextData.acceptDeliverySlot = true
        } else {
          if (hasPhoneInput && requestedPhone && !isPhoneValid(requestedPhone)) return fail('INVALID_PHONE', '请填写有效电话')
          nextData.address = null
          nextData.addressId = null
          nextData.deliveryTimeSlotLabelSnapshot = null
          nextData.acceptDeliverySlot = false
        }

        await db.collection('orders').doc(orderId).update({ data: nextData })
        await db.collection('order_audit_logs').add({
          data: {
            orderId,
            action: 'ADMIN_UPDATE_FULFILLMENT',
            byOpenId: openId,
            at: db.serverDate(),
            detail: {
              from: String(order.fulfillmentType || ''),
              to: fulfillmentType,
              addressSource,
              phoneChanged: nextData.contact.phone !== currentPhone,
            },
          },
        })
      } catch (err) {
        return fail('TX_FAILED', 'Update fulfillment failed', String(err && err.message))
      }
      return ok({})
    },

    async updateOrderItems(event, ctx) {
      const openId = ctx && ctx.openId
      const { orderId } = event
      const incomingItems = Array.isArray(event.items) ? event.items : []
      if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
      let txRes
      try {
        txRes = await db.runTransaction(async (tx) => {
          let order
          try {
            const orderGet = await tx.collection('orders').doc(orderId).get()
            order = orderGet.data
          } catch (err) {
            throwBiz('ORDER_NOT_FOUND', 'Order not found')
          }
          if (!order) throwBiz('ORDER_NOT_FOUND', 'Order not found')
          if (order.status !== ORDER_STATUS.ACTIVE && order.status !== ORDER_STATUS.PENDING_REVIEW) {
            throwBiz('ORDER_NOT_EDITABLE', 'Order is not editable')
          }

          const oldItems = Array.isArray(order.items) ? order.items : []
          if (oldItems.length === 0) throwBiz('BAD_REQUEST', 'Order has no editable items')

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
            nextQtyMap.set(dishId, Math.floor(qty))
          }
          for (const dishId of oldMap.keys()) {
            if (!nextQtyMap.has(dishId)) nextQtyMap.set(dishId, 0)
          }

          const unknownDishIds = Array.from(nextQtyMap.keys()).filter((dishId) => !oldMap.has(dishId))
          const dishRowMap = new Map()
          if (unknownDishIds.length > 0) {
            const chunkSize = 10
            for (let i = 0; i < unknownDishIds.length; i += chunkSize) {
              const chunk = unknownDishIds.slice(i, i + chunkSize)
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
            const missingDishIds = unknownDishIds.filter((dishId) => !dishRowMap.has(dishId))
            if (missingDishIds.length > 0) {
              throwBiz('ITEM_NOT_FOUND', 'Dish not found', { missingDishIds })
            }
          }

          const nextItems = []
          let totalQty = 0
          let totalAmountCents = 0
          for (const [dishId, nextQty] of nextQtyMap.entries()) {
            if (nextQty <= 0) continue
            const old = oldMap.get(dishId)
            const dishRow = dishRowMap.get(dishId) || null
            const unitPriceCents = Math.max(
              0,
              toSafeInt(old && (old.unitPriceCents != null ? old.unitPriceCents : old.priceCents), toSafeInt(dishRow && dishRow.priceCents, 0))
            )
            const dishName = String((old && old.dishName) || (dishRow && dishRow.name) || '')
            if (!dishName) throwBiz('BAD_REQUEST', 'Invalid order item')
            const lineTotalCents = unitPriceCents * nextQty
            totalQty += nextQty
            totalAmountCents += lineTotalCents
            nextItems.push({ dishId, dishName, unitPriceCents, qty: nextQty, lineTotalCents })
          }
          if (nextItems.length === 0) throwBiz('BAD_REQUEST', 'Order cannot be empty, cancel it instead')

          const expandedLimits = []
          let saleVersionSnapshot = toSafeInt(order.saleConfigVersionSnapshot, 0)
          if (order.status === ORDER_STATUS.ACTIVE && order.saleId) {
            const sale = await getSaleTx(tx, order.saleId)
            if (sale) {
              const cfgMap = dishConfigMap(sale.dishConfigs)
              const appendedDishIds = []
              for (const [dishId, nextQty] of nextQtyMap.entries()) {
                const oldQty = toSafeInt(oldMap.get(dishId) && oldMap.get(dishId).qty, 0)
                const delta = nextQty - oldQty
                if (delta === 0) continue
                let cfgItem = cfgMap.get(dishId)
                if (!cfgItem) {
                  cfgItem = { dishId, limitQty: 0, soldQty: 0 }
                  cfgMap.set(dishId, cfgItem)
                  appendedDishIds.push(dishId)
                }
                if (delta > 0) {
                  const remain = Math.max(0, toSafeInt(cfgItem.limitQty, 0) - toSafeInt(cfgItem.soldQty, 0))
                  if (delta > remain) {
                    const grow = delta - remain
                    cfgItem.limitQty = Math.max(0, toSafeInt(cfgItem.limitQty, 0) + grow)
                    expandedLimits.push({
                      dishId,
                      increaseBy: grow,
                      newLimitQty: cfgItem.limitQty,
                    })
                  }
                }
                cfgItem.soldQty = Math.max(0, toSafeInt(cfgItem.soldQty, 0) + delta)
                cfgMap.set(dishId, cfgItem)
              }
              const nextConfigs = []
              const pushed = new Set()
              for (const x of normalizeDishConfigs(sale.dishConfigs)) {
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
              for (const [dishId, row] of dishRowMap.entries()) {
                dishSnapshotMap.set(dishId, {
                  name: String((row && row.name) || '').trim(),
                  priceCents: Math.max(0, toSafeInt(row && row.priceCents, 0)),
                })
              }
              for (const it of nextItems) {
                if (!dishSnapshotMap.has(it.dishId)) {
                  dishSnapshotMap.set(it.dishId, {
                    name: String(it.dishName || '').trim(),
                    priceCents: Math.max(0, toSafeInt(it.unitPriceCents, 0)),
                  })
                }
              }
              await tx.collection('sales').doc(order.saleId).update({
                data: {
                  updatedAt: db.serverDate(),
                },
              })
              await replaceSaleItemsForSaleTx(tx, order.saleId, nextConfigs, { dishSnapshotMap })
            }
            saleVersionSnapshot = toSafeInt(sale && sale.saleConfigVersion, saleVersionSnapshot)
          }

          const now = db.serverDate()
          await tx.collection('orders').doc(orderId).update({
            data: {
              items: nextItems,
              totals: { qty: totalQty, amountCents: totalAmountCents },
              saleConfigVersionSnapshot: saleVersionSnapshot,
              updatedAt: now,
            },
          })
          await tx.collection('order_audit_logs').add({
            data: {
              orderId,
              action: order.status === ORDER_STATUS.ACTIVE ? 'ADMIN_UPDATE_ITEMS' : 'ADMIN_UPDATE_PENDING_ITEMS',
              byOpenId: openId,
              at: now,
            },
          })
          return { totalQty, totalAmountCents, expandedLimits }
        })
      } catch (err) {
        if (err && err.code) return fail(err.code, err.message || 'Request failed', err.detail)
        return fail('TX_FAILED', 'Update order failed', String(err && err.message))
      }
      return ok(txRes || {})
    },

    async cancelOrder(event, ctx) {
      const openId = ctx && ctx.openId
      const { orderId } = event
      if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
      let txRes
      try {
        txRes = await db.runTransaction(async (tx) => {
          let order = null
          try {
            const r = await tx.collection('orders').doc(orderId).get()
            order = r.data
          } catch (err) {
            throw Object.assign(new Error('ORDER_NOT_FOUND'), { code: 'ORDER_NOT_FOUND' })
          }
          if (!order) throw Object.assign(new Error('ORDER_NOT_FOUND'), { code: 'ORDER_NOT_FOUND' })
          if (order.status === ORDER_STATUS.CANCELLED || order.status === ORDER_STATUS.REJECTED) return { alreadyCancelled: true }

          const now = db.serverDate()
          await tx.collection('orders').doc(orderId).update({
            data: { status: ORDER_STATUS.CANCELLED, cancelledAt: now, cancelledByOpenId: openId, updatedAt: now },
          })

          if (order.status === ORDER_STATUS.ACTIVE && order.saleId) {
            const sale = await getSaleTx(tx, order.saleId)
            if (sale && Array.isArray(sale.dishConfigs)) {
              const cfgMap = dishConfigMap(sale.dishConfigs)
              for (const it of order.items || []) {
                const dishId = String((it && it.dishId) || '').trim()
                const qty = toSafeInt(it && it.qty, 0)
                if (!dishId || qty <= 0) continue
                const cfgItem = cfgMap.get(dishId)
                if (!cfgItem) continue
                cfgItem.soldQty = Math.max(0, toSafeInt(cfgItem.soldQty, 0) - qty)
                cfgMap.set(dishId, cfgItem)
              }
              const mergedConfigs = (sale.dishConfigs || []).map((it) => {
                const cfgItem = cfgMap.get(it.dishId)
                return cfgItem || it
              })
              await tx.collection('sales').doc(order.saleId).update({
                data: { updatedAt: db.serverDate() },
              })
              await replaceSaleItemsForSaleTx(tx, order.saleId, mergedConfigs)
            }
          }
          return { alreadyCancelled: false }
        })
      } catch (err) {
        if (err && err.code === 'ORDER_NOT_FOUND') return fail('ORDER_NOT_FOUND', 'Order not found')
        return fail('TX_FAILED', 'Cancel order failed', String(err && err.message))
      }
      if (txRes && txRes.alreadyCancelled) return ok({})
      const now = db.serverDate()
      await db.collection('order_audit_logs').add({
        data: { orderId, action: 'CANCEL', byOpenId: openId, at: now },
      })
      return ok({})
    },
  }
}

module.exports = {
  createOrderWriteService,
}
