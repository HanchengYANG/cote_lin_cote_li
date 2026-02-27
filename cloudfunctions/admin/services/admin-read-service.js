function createAdminReadService(deps) {
  const {
    db,
    _,
    ok,
    fail,
    getAllByPaging,
    ORDER_STATUS,
    getCustomersByOpenIds,
    getCustomerAddressesByOpenIds,
    buildAddressMapByOpenId,
    pickDefaultPhone,
    getSale,
    toEpochMs,
    toSafeInt,
    normalizePhone,
    isPhoneValid,
    normalizeAddressPayload,
    buildAddressId,
    formatOrderAddress,
    normalizeStoredAddresses,
  } = deps

  function throwBiz(code, message, detail) {
    const err = new Error(message || code || 'BIZ_ERROR')
    err.code = code || 'BIZ_ERROR'
    err.detail = detail
    throw err
  }

  function normalizeAddressBookInput(input) {
    const normalized = normalizeAddressPayload(input)
    if (!normalized) throwBiz('INVALID_ADDRESS', '地址格式不正确')
    const label = String((normalized && normalized.label) || '').trim()
    if (!label) throwBiz('INVALID_ADDRESS', '地址名称不能为空')
    const phone = normalizePhone(input && input.phone)
    if (!isPhoneValid(phone)) throwBiz('INVALID_PHONE', '请填写有效电话')
    return {
      ...normalized,
      label,
      phone,
    }
  }

  async function getCustomerProfileOrThrowTx(tx, customerOpenId) {
    let customer = null
    try {
      const got = await tx.collection('customer_profiles').doc(customerOpenId).get()
      customer = got && got.data ? got.data : null
    } catch (err) {
      customer = null
    }
    if (!customer) throwBiz('NOT_FOUND', 'Customer not found')
    return customer
  }

  async function listCustomerAddressesTx(tx, customerOpenId) {
    try {
      const rows = await getAllByPaging(
        (skip, limit) => tx.collection('customer_addresses').where({ customerOpenId }).skip(skip).limit(limit),
        { pageSize: 100 }
      )
      return normalizeStoredAddresses(rows)
    } catch (err) {
      return []
    }
  }

  async function listCustomerAddresses(customerOpenId) {
    try {
      const rows = await getAllByPaging(
        (skip, limit) => db.collection('customer_addresses').where({ customerOpenId }).skip(skip).limit(limit),
        { pageSize: 100 }
      )
      return normalizeStoredAddresses(rows)
    } catch (err) {
      return []
    }
  }

  function pickValidDefaultAddressId(addresses, defaultAddressId) {
    const arr = Array.isArray(addresses) ? addresses : []
    const raw = String(defaultAddressId || '').trim()
    if (arr.some((x) => String((x && x.id) || '').trim() === raw)) return raw
    return arr[0] ? String((arr[0] && arr[0].id) || '').trim() : ''
  }

  async function loadCustomerAddressBook(customerOpenId) {
    let customer = null
    try {
      const r = await db.collection('customer_profiles').doc(customerOpenId).get()
      customer = r && r.data ? r.data : null
    } catch (err) {
      customer = null
    }
    if (!customer) throwBiz('NOT_FOUND', 'Customer not found')
    const addresses = await listCustomerAddresses(customerOpenId)
    const defaultAddressId = pickValidDefaultAddressId(addresses, customer && customer.defaultAddressId)
    return {
      customer: {
        customerOpenId,
        nickname: String((customer && customer.nickname) || '').trim(),
        defaultAddressId,
        updatedAt: (customer && customer.updatedAt) || null,
      },
      addresses,
    }
  }

  function resolveOrderAddressText(order, addressesByOpenId) {
    if (!order || String((order && order.fulfillmentType) || '').trim() !== 'delivery') return ''
    const addressId = String((order && order.addressId) || '').trim()
    if (!addressId) return ''
    const customerOpenId = String((order && order.customerOpenId) || '').trim()
    const customerAddresses = (addressesByOpenId && addressesByOpenId.get(customerOpenId)) || []
    const picked = customerAddresses.find((x) => String((x && x.id) || '').trim() === addressId) || null
    return picked ? formatOrderAddress(picked) : ''
  }

  return {
    async listOrders(event) {
      const saleId = event.saleId
      if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')
      const fulfillmentType = event.fulfillmentType
      const status = String(event.status || '').trim()
      const where = { saleId }
      if (fulfillmentType === 'delivery' || fulfillmentType === 'pickup') where.fulfillmentType = fulfillmentType
      if (
        status === ORDER_STATUS.ACTIVE ||
        status === ORDER_STATUS.CANCELLED ||
        status === ORDER_STATUS.PENDING_REVIEW ||
        status === ORDER_STATUS.REJECTED
      ) {
        where.status = status
      }
      const orders = await getAllByPaging((skip, limit) => db.collection('orders').where(where).skip(skip).limit(limit), {
        pageSize: 100,
      })
      const openIds = Array.from(
        new Set(
          orders
            .map((o) => String((o && o.customerOpenId) || '').trim())
            .filter(Boolean)
        )
      )
      const nicknameByOpenId = {}
      const customers = await getCustomersByOpenIds(openIds)
      const addressRows = await getCustomerAddressesByOpenIds(openIds)
      const addressesByOpenId = buildAddressMapByOpenId(addressRows)
      for (const c of customers) {
        const id = String((c && c._id) || '').trim()
        if (!id) continue
        nicknameByOpenId[id] = String((c && c.nickname) || '').trim()
      }
      const withCustomer = orders.map((o) => {
        const id = String((o && o.customerOpenId) || '').trim()
        const { address, ...rest } = o || {}
        return {
          ...rest,
          customerNickname: nicknameByOpenId[id] || '',
          addressText: resolveOrderAddressText(o, addressesByOpenId),
        }
      })
      return ok({ orders: withCustomer })
    },

    async getSaleReview(event) {
      const saleId = String(event.saleId || '').trim()
      if (!saleId) return fail('BAD_REQUEST', 'Missing saleId')

      let sale = null
      try {
        sale = await getSale(saleId)
      } catch (err) {
        sale = null
      }
      if (!sale) return fail('NOT_FOUND', 'Sale not found')
      if (String((sale && sale.status) || '').trim() === 'DRAFT') {
        return fail('BAD_REQUEST', 'Draft sale is not reviewable')
      }

      const rawOrders = await getAllByPaging(
        (skip, limit) => db.collection('orders').where({ saleId, status: ORDER_STATUS.ACTIVE }).skip(skip).limit(limit),
        { pageSize: 100 }
      )
      rawOrders.sort((a, b) => toEpochMs(a && a.createdAt) - toEpochMs(b && b.createdAt))

      const customerOpenIds = Array.from(
        new Set(
          rawOrders
            .map((o) => String((o && o.customerOpenId) || '').trim())
            .filter(Boolean)
        )
      )
      const customerList = await getCustomersByOpenIds(customerOpenIds)
      const nicknameByOpenId = new Map()
      for (const c of customerList) {
        const id = String((c && c._id) || '').trim()
        if (!id) continue
        nicknameByOpenId.set(id, String((c && c.nickname) || '').trim())
      }

      const dishAgg = new Map()
      let totalQty = 0
      let revenueCents = 0

      const orders = rawOrders.map((o) => {
        const customerOpenId = String((o && o.customerOpenId) || '').trim()

        let orderQty = toSafeInt(o && o.totals && o.totals.qty, 0)
        let orderAmountCents = toSafeInt(o && o.totals && o.totals.amountCents, 0)
        let computedQty = 0
        let computedAmountCents = 0

        const items = (Array.isArray(o && o.items) ? o.items : []).map((it) => {
          const dishId = String((it && it.dishId) || '').trim()
          const dishName = String((it && it.dishName) || '').trim() || dishId || '未知菜品'
          const qty = Math.max(0, toSafeInt(it && it.qty, 0))
          const unitPriceCents = toSafeInt(it && (it.unitPriceCents != null ? it.unitPriceCents : it.priceCents), 0)
          const lineTotalCents = toSafeInt(it && it.lineTotalCents, unitPriceCents * qty)
          computedQty += qty
          computedAmountCents += lineTotalCents

          if (qty > 0) {
            const prev = dishAgg.get(dishId || dishName) || {
              dishId: dishId || '',
              dishName,
              qty: 0,
              amountCents: 0,
            }
            prev.qty += qty
            prev.amountCents += lineTotalCents
            if (!prev.dishName && dishName) prev.dishName = dishName
            if (!prev.dishId && dishId) prev.dishId = dishId
            dishAgg.set(dishId || dishName, prev)
          }

          return {
            dishId,
            dishName,
            qty,
            unitPriceCents,
            lineTotalCents,
          }
        })

        if (orderQty <= 0 && computedQty > 0) orderQty = computedQty
        if (orderAmountCents <= 0 && computedAmountCents > 0) orderAmountCents = computedAmountCents
        totalQty += orderQty
        revenueCents += orderAmountCents

        return {
          _id: String((o && o._id) || ''),
          saleId: String((o && o.saleId) || ''),
          createdAt: (o && o.createdAt) || null,
          status: String((o && o.status) || ''),
          fulfillmentType: String((o && o.fulfillmentType) || 'pickup'),
          deliveryTimeSlotLabelSnapshot: String((o && o.deliveryTimeSlotLabelSnapshot) || ''),
          customerOpenId,
          customerNickname: nicknameByOpenId.get(customerOpenId) || '',
          contact: {
            phone: normalizePhone(o && o.contact && o.contact.phone),
          },
          address: o && o.address ? o.address : null,
          addressText: formatOrderAddress(o && o.address),
          remark: String((o && o.remark) || ''),
          totals: {
            qty: orderQty,
            amountCents: orderAmountCents,
          },
          items,
        }
      })

      const dishSales = Array.from(dishAgg.values()).sort((a, b) => {
        if (b.qty !== a.qty) return b.qty - a.qty
        return String(a.dishName || '').localeCompare(String(b.dishName || ''))
      })

      return ok({
        sale: {
          _id: String((sale && sale._id) || saleId),
          status: String((sale && sale.status) || ''),
          createdAt: (sale && sale.createdAt) || null,
          deliveryTimeSlotLabel: String((sale && sale.deliveryTimeSlotLabel) || ''),
        },
        summary: {
          orderCount: orders.length,
          totalQty,
          revenueCents,
          revenueEuro: (Number(revenueCents || 0) / 100).toFixed(2),
        },
        dishSales,
        orders,
      })
    },

    async listCustomers() {
      let customers = []
      try {
        customers = await getAllByPaging((skip, limit) => db.collection('customer_profiles').skip(skip).limit(limit), {
          pageSize: 100,
        })
      } catch (err) {
        customers = []
      }
      const openIds = Array.from(new Set(customers.map((c) => String((c && c._id) || '').trim()).filter(Boolean)))
      const addressRows = await getCustomerAddressesByOpenIds(openIds)
      const addressesByOpenId = buildAddressMapByOpenId(addressRows)
      const statsByOpenId = new Map()
      const chunkSize = 20
      for (let i = 0; i < openIds.length; i += chunkSize) {
        const chunk = openIds.slice(i, i + chunkSize)
        let orders = []
        try {
          orders = await getAllByPaging(
            (skip, limit) => db.collection('orders').where({ customerOpenId: _.in(chunk) }).skip(skip).limit(limit),
            { pageSize: 100 }
          )
        } catch (err) {
          orders = []
        }
        for (const o of orders) {
          const id = String((o && o.customerOpenId) || '').trim()
          if (!id) continue
          const prev = statsByOpenId.get(id) || { orderCount: 0, lastOrderAtMs: 0, lastOrderAt: null }
          const curMs = toEpochMs(o && o.createdAt)
          const next = {
            orderCount: prev.orderCount + 1,
            lastOrderAtMs: prev.lastOrderAtMs,
            lastOrderAt: prev.lastOrderAt,
          }
          if (curMs >= prev.lastOrderAtMs) {
            next.lastOrderAtMs = curMs
            next.lastOrderAt = o && o.createdAt ? o.createdAt : null
          }
          statsByOpenId.set(id, next)
        }
      }

      const rows = customers.map((c) => {
        const customerOpenId = String((c && c._id) || '').trim()
        const nickname = String((c && c.nickname) || '').trim()
        const addresses = addressesByOpenId.get(customerOpenId) || []
        const defaultAddressId = String((c && c.defaultAddressId) || '').trim()
        const stats = statsByOpenId.get(customerOpenId) || { orderCount: 0, lastOrderAt: null, lastOrderAtMs: 0 }
        return {
          customerOpenId,
          nickname,
          addressCount: addresses.length,
          defaultPhone: pickDefaultPhone(addresses, defaultAddressId),
          orderCount: stats.orderCount,
          lastOrderAt: stats.lastOrderAt || null,
          updatedAt: (c && c.updatedAt) || null,
        }
      })

      rows.sort((a, b) => {
        const ta = toEpochMs(a.lastOrderAt) || toEpochMs(a.updatedAt)
        const tb = toEpochMs(b.lastOrderAt) || toEpochMs(b.updatedAt)
        return tb - ta
      })
      return ok({ customers: rows })
    },

    async getCustomerDetail(event) {
      const customerOpenId = String(event.customerOpenId || '').trim()
      if (!customerOpenId) return fail('BAD_REQUEST', 'Missing customerOpenId')
      let customer = null
      try {
        const r = await db.collection('customer_profiles').doc(customerOpenId).get()
        customer = r.data || null
      } catch (err) {
        customer = null
      }
      if (!customer) return fail('NOT_FOUND', 'Customer not found')
      const customerAddresses = await listCustomerAddresses(customerOpenId)

      let orders = []
      try {
        orders = await getAllByPaging(
          (skip, limit) => db.collection('orders').where({ customerOpenId }).skip(skip).limit(limit),
          { pageSize: 100 }
        )
      } catch (err) {
        orders = []
      }
      orders.sort((a, b) => toEpochMs(b && b.createdAt) - toEpochMs(a && a.createdAt))

      const nickname = String((customer && customer.nickname) || '').trim()
      const withCustomer = orders.map((o) => ({
        ...o,
        customerNickname: nickname,
      }))

      return ok({
        customer: {
          customerOpenId,
          nickname,
          defaultAddressId: String((customer && customer.defaultAddressId) || '').trim(),
          addresses: customerAddresses,
          updatedAt: customer && customer.updatedAt ? customer.updatedAt : null,
        },
        orders: withCustomer,
      })
    },

    async getCustomerAddressBook(event) {
      const customerOpenId = String((event && event.customerOpenId) || '').trim()
      if (!customerOpenId) return fail('BAD_REQUEST', 'Missing customerOpenId')
      try {
        const loaded = await loadCustomerAddressBook(customerOpenId)
        return ok(loaded)
      } catch (err) {
        if (err && err.code) return fail(err.code, err.message || 'Request failed', err.detail)
        return fail('TX_FAILED', 'Load address book failed', String(err && err.message))
      }
    },

    async addCustomerAddress(event) {
      const customerOpenId = String((event && event.customerOpenId) || '').trim()
      if (!customerOpenId) return fail('BAD_REQUEST', 'Missing customerOpenId')
      const setDefault = !!(event && event.setDefault)
      let nextAddressId = ''
      try {
        await db.runTransaction(async (tx) => {
          const customer = await getCustomerProfileOrThrowTx(tx, customerOpenId)
          const normalizedAddress = normalizeAddressBookInput(event && event.address)
          const now = db.serverDate()
          const nowMs = Date.now()
          const addressId = buildAddressId()
          nextAddressId = addressId
          await tx.collection('customer_addresses').doc(addressId).set({
            data: {
              customerOpenId,
              id: addressId,
              label: normalizedAddress.label,
              line1: normalizedAddress.line1,
              line2: normalizedAddress.line2,
              postalCode: normalizedAddress.postalCode,
              city: normalizedAddress.city,
              phone: normalizedAddress.phone,
              country: 'FR',
              createdAtMs: nowMs,
              updatedAtMs: nowMs,
              createdAt: now,
              updatedAt: now,
            },
          })
          const addresses = await listCustomerAddressesTx(tx, customerOpenId)
          const defaultAddressId = setDefault
            ? addressId
            : pickValidDefaultAddressId(addresses, String((customer && customer.defaultAddressId) || '').trim())
          await tx.collection('customer_profiles').doc(customerOpenId).update({
            data: {
              defaultAddressId,
              updatedAt: now,
            },
          })
        })
      } catch (err) {
        if (err && err.code) return fail(err.code, err.message || 'Request failed', err.detail)
        return fail('TX_FAILED', 'Add address failed', String(err && err.message))
      }
      try {
        const loaded = await loadCustomerAddressBook(customerOpenId)
        return ok({ ...loaded, addressId: nextAddressId })
      } catch (err) {
        return ok({ addressId: nextAddressId })
      }
    },

    async updateCustomerAddress(event) {
      const customerOpenId = String((event && event.customerOpenId) || '').trim()
      const addressId = String((event && event.addressId) || '').trim()
      if (!customerOpenId) return fail('BAD_REQUEST', 'Missing customerOpenId')
      if (!addressId) return fail('BAD_REQUEST', 'Missing addressId')
      const setDefault = !!(event && event.setDefault)
      try {
        await db.runTransaction(async (tx) => {
          await getCustomerProfileOrThrowTx(tx, customerOpenId)
          let currentAddress = null
          try {
            const got = await tx.collection('customer_addresses').doc(addressId).get()
            currentAddress = got && got.data ? got.data : null
          } catch (err) {
            currentAddress = null
          }
          if (!currentAddress || String((currentAddress && currentAddress.customerOpenId) || '').trim() !== customerOpenId) {
            throwBiz('ADDRESS_NOT_FOUND', '地址不存在')
          }
          const normalizedAddress = normalizeAddressBookInput(event && event.address)
          const now = db.serverDate()
          await tx.collection('customer_addresses').doc(addressId).update({
            data: {
              label: normalizedAddress.label,
              line1: normalizedAddress.line1,
              line2: normalizedAddress.line2,
              postalCode: normalizedAddress.postalCode,
              city: normalizedAddress.city,
              phone: normalizedAddress.phone,
              country: 'FR',
              updatedAtMs: Date.now(),
              updatedAt: now,
            },
          })
          if (setDefault) {
            await tx.collection('customer_profiles').doc(customerOpenId).update({
              data: {
                defaultAddressId: addressId,
                updatedAt: now,
              },
            })
          }
        })
      } catch (err) {
        if (err && err.code) return fail(err.code, err.message || 'Request failed', err.detail)
        return fail('TX_FAILED', 'Update address failed', String(err && err.message))
      }
      try {
        const loaded = await loadCustomerAddressBook(customerOpenId)
        return ok(loaded)
      } catch (err) {
        return ok({})
      }
    },

    async deleteCustomerAddress(event) {
      const customerOpenId = String((event && event.customerOpenId) || '').trim()
      const addressId = String((event && event.addressId) || '').trim()
      if (!customerOpenId) return fail('BAD_REQUEST', 'Missing customerOpenId')
      if (!addressId) return fail('BAD_REQUEST', 'Missing addressId')
      try {
        await db.runTransaction(async (tx) => {
          const customer = await getCustomerProfileOrThrowTx(tx, customerOpenId)
          let currentAddress = null
          try {
            const got = await tx.collection('customer_addresses').doc(addressId).get()
            currentAddress = got && got.data ? got.data : null
          } catch (err) {
            currentAddress = null
          }
          if (!currentAddress || String((currentAddress && currentAddress.customerOpenId) || '').trim() !== customerOpenId) {
            throwBiz('ADDRESS_NOT_FOUND', '地址不存在')
          }
          await tx.collection('customer_addresses').doc(addressId).remove()
          const addresses = await listCustomerAddressesTx(tx, customerOpenId)
          const oldDefaultAddressId = String((customer && customer.defaultAddressId) || '').trim()
          const defaultAddressId =
            oldDefaultAddressId === addressId || !addresses.some((x) => String((x && x.id) || '').trim() === oldDefaultAddressId)
              ? (addresses[0] ? String((addresses[0] && addresses[0].id) || '').trim() : '')
              : oldDefaultAddressId
          await tx.collection('customer_profiles').doc(customerOpenId).update({
            data: {
              defaultAddressId,
              updatedAt: db.serverDate(),
            },
          })
        })
      } catch (err) {
        if (err && err.code) return fail(err.code, err.message || 'Request failed', err.detail)
        return fail('TX_FAILED', 'Delete address failed', String(err && err.message))
      }
      try {
        const loaded = await loadCustomerAddressBook(customerOpenId)
        return ok(loaded)
      } catch (err) {
        return ok({})
      }
    },

    async setCustomerDefaultAddress(event) {
      const customerOpenId = String((event && event.customerOpenId) || '').trim()
      const addressId = String((event && event.addressId) || '').trim()
      if (!customerOpenId) return fail('BAD_REQUEST', 'Missing customerOpenId')
      if (!addressId) return fail('BAD_REQUEST', 'Missing addressId')
      try {
        await db.runTransaction(async (tx) => {
          await getCustomerProfileOrThrowTx(tx, customerOpenId)
          let currentAddress = null
          try {
            const got = await tx.collection('customer_addresses').doc(addressId).get()
            currentAddress = got && got.data ? got.data : null
          } catch (err) {
            currentAddress = null
          }
          if (!currentAddress || String((currentAddress && currentAddress.customerOpenId) || '').trim() !== customerOpenId) {
            throwBiz('ADDRESS_NOT_FOUND', '地址不存在')
          }
          await tx.collection('customer_profiles').doc(customerOpenId).update({
            data: {
              defaultAddressId: addressId,
              updatedAt: db.serverDate(),
            },
          })
        })
      } catch (err) {
        if (err && err.code) return fail(err.code, err.message || 'Request failed', err.detail)
        return fail('TX_FAILED', 'Set default address failed', String(err && err.message))
      }
      try {
        const loaded = await loadCustomerAddressBook(customerOpenId)
        return ok(loaded)
      } catch (err) {
        return ok({})
      }
    },

    async getOrderDetail(event) {
      const { orderId } = event
      if (!orderId) return fail('BAD_REQUEST', 'Missing orderId')
      try {
        const r = await db.collection('orders').doc(orderId).get()
        const order = r.data || null
        if (!order) return fail('ORDER_NOT_FOUND', 'Order not found')
        let customerAddresses = []
        let customerNickname = ''
        if (order.customerOpenId) {
          try {
            const [customerRes, addressRes] = await Promise.all([
              db.collection('customer_profiles').doc(order.customerOpenId).get(),
              db.collection('customer_addresses').where({ customerOpenId: order.customerOpenId }).get(),
            ])
            customerNickname = String((customerRes && customerRes.data && customerRes.data.nickname) || '').trim()
            customerAddresses = normalizeStoredAddresses((addressRes && addressRes.data) || [])
          } catch (err) {
            customerNickname = ''
            customerAddresses = []
          }
        }
        return ok({ order: { ...order, customerNickname }, customerAddresses })
      } catch (err) {
        return fail('ORDER_NOT_FOUND', 'Order not found')
      }
    },
  }
}

module.exports = {
  createAdminReadService,
}
