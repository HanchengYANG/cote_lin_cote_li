function buildCustomerSearchText(row) {
  return [
    String((row && row.nickname) || '').trim(),
    String((row && row.defaultPhone) || '').trim(),
    String((row && row.customerOpenId) || '').trim(),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function normalizeBootstrapDishRow(dishRow, cfg) {
  const limitQty = Number((cfg && cfg.limitQty) || 0)
  const soldQty = Number((cfg && cfg.soldQty) || 0)
  return {
    _id: String((dishRow && dishRow._id) || (cfg && cfg.dishId) || ''),
    name: String((dishRow && dishRow.name) || '').trim() || String((cfg && cfg.dishId) || ''),
    priceCents: Number((dishRow && dishRow.priceCents) || 0),
    isActive: !!(dishRow && dishRow.isActive),
    inCurrentSale: !!cfg,
    limitQty,
    soldQty,
    remainingQty: Math.max(0, limitQty - soldQty),
  }
}

function createManualOrderReadService(deps) {
  const {
    db,
    getAllByPaging,
    ok,
    getSale,
    getCustomerAddressesByOpenIds,
    buildAddressMapByOpenId,
    pickDefaultPhone,
    normalizePhone,
  } = deps

  async function listRecentCustomerProfiles(limit = 60) {
    const max = Math.max(1, Math.min(100, Number(limit || 60) || 60))
    try {
      const r = await db.collection('customer_profiles').orderBy('updatedAt', 'desc').limit(max).get()
      return Array.isArray(r && r.data) ? r.data : []
    } catch (err) {
      try {
        const r = await db.collection('customer_profiles').limit(max).get()
        const rows = Array.isArray(r && r.data) ? r.data : []
        rows.sort((a, b) => {
          const ta = new Date((a && (a.updatedAt || a.createdAt)) || 0).getTime() || 0
          const tb = new Date((b && (b.updatedAt || b.createdAt)) || 0).getTime() || 0
          return tb - ta
        })
        return rows.slice(0, max)
      } catch (err2) {
        return []
      }
    }
  }

  return {
    async getManualOrderCreateBootstrap(_event) {
      let openSale = null
      try {
        const r = await db.collection('sales').where({ status: 'OPEN' }).orderBy('createdAt', 'desc').limit(1).get()
        openSale = (r && Array.isArray(r.data) && r.data[0]) || null
      } catch (err) {
        openSale = null
      }

      let sale = null
      let dishes = []
      if (openSale && openSale._id) {
        try {
          sale = await getSale(openSale._id)
        } catch (err) {
          sale = null
        }
      }
      const saleConfigs = Array.isArray(sale && sale.dishConfigs) ? sale.dishConfigs : []
      const saleCfgByDishId = new Map()
      for (const cfg of saleConfigs) {
        const dishId = String((cfg && cfg.dishId) || '').trim()
        if (!dishId) continue
        saleCfgByDishId.set(dishId, cfg)
      }

      let allDishRows = []
      try {
        allDishRows = await getAllByPaging((skip, limit) => db.collection('dishes').skip(skip).limit(limit), { pageSize: 100 })
      } catch (err) {
        allDishRows = []
      }
      const visibleDishRows = (Array.isArray(allDishRows) ? allDishRows : []).filter((row) => {
        const id = String((row && row._id) || '').trim()
        if (!id) return false
        if (saleCfgByDishId.has(id)) return true
        return !!(row && row.isActive)
      })
      dishes = visibleDishRows.map((row) => {
        const dishId = String((row && row._id) || '').trim()
        const cfg = saleCfgByDishId.get(dishId) || null
        return normalizeBootstrapDishRow(row, cfg)
      })
      for (const cfg of saleConfigs) {
        const dishId = String((cfg && cfg.dishId) || '').trim()
        if (!dishId) continue
        if (dishes.some((d) => String((d && d._id) || '').trim() === dishId)) continue
        dishes.push(normalizeBootstrapDishRow(null, cfg))
      }

      const recentProfiles = await listRecentCustomerProfiles(60)
      const customerOpenIds = recentProfiles.map((c) => String((c && c._id) || '').trim()).filter(Boolean)
      const addressRows = await getCustomerAddressesByOpenIds(customerOpenIds)
      const addressesByOpenId = buildAddressMapByOpenId(addressRows)
      const recentCustomers = recentProfiles.map((c) => {
        const customerOpenId = String((c && c._id) || '').trim()
        const nickname = String((c && c.nickname) || '').trim()
        const addresses = addressesByOpenId.get(customerOpenId) || []
        const defaultAddressId = String((c && c.defaultAddressId) || '').trim()
        const defaultAddress = addresses.find((x) => String((x && x.id) || '').trim() === defaultAddressId) || addresses[0] || null
        return {
          customerOpenId,
          nickname,
          isManualCreated: !!(c && c.isManualCreated),
          defaultPhone: pickDefaultPhone(addresses, defaultAddressId),
          profilePhone: normalizePhone(c && c.profilePhone),
          addressCount: addresses.length,
          defaultAddressText: defaultAddress
            ? [defaultAddress.line1, defaultAddress.line2, defaultAddress.postalCode, defaultAddress.city, defaultAddress.country]
                .filter(Boolean)
                .join(', ')
            : '',
          updatedAt: (c && c.updatedAt) || null,
          searchText: '',
        }
      })
      for (const row of recentCustomers) {
        row.searchText = buildCustomerSearchText(row)
      }

      return ok({
        sale: sale
          ? {
              _id: String((sale && sale._id) || ''),
              status: String((sale && sale.status) || ''),
              deliveryTimeSlotLabel: String((sale && sale.deliveryTimeSlotLabel) || ''),
              saleConfigVersion: Number((sale && sale.saleConfigVersion) || 0),
            }
          : null,
        dishes,
        recentCustomers,
      })
    },

    async searchCustomersForManualOrder(event) {
      const keyword = String((event && event.keyword) || '').trim().toLowerCase()
      const max = Math.max(1, Math.min(50, Number((event && event.limit) || 20) || 20))
      if (!keyword) return ok({ customers: [] })
      let rows = []
      try {
        const r = await db.collection('customer_profiles').limit(200).get()
        rows = Array.isArray(r && r.data) ? r.data : []
      } catch (err) {
        rows = []
      }
      const matchedProfiles = rows
        .filter((c) => {
          const txt = `${String((c && c.nickname) || '').trim()} ${String((c && c._id) || '').trim()}`.toLowerCase()
          return txt.includes(keyword)
        })
        .slice(0, max)
      const ids = matchedProfiles.map((c) => String((c && c._id) || '').trim()).filter(Boolean)
      const addressRows = await getCustomerAddressesByOpenIds(ids)
      const addressesByOpenId = buildAddressMapByOpenId(addressRows)
      const customers = matchedProfiles.map((c) => {
        const customerOpenId = String((c && c._id) || '').trim()
        const addresses = addressesByOpenId.get(customerOpenId) || []
        const defaultAddressId = String((c && c.defaultAddressId) || '').trim()
        return {
          customerOpenId,
          nickname: String((c && c.nickname) || '').trim(),
          isManualCreated: !!(c && c.isManualCreated),
          defaultPhone: pickDefaultPhone(addresses, defaultAddressId),
          profilePhone: normalizePhone(c && c.profilePhone),
          addressCount: addresses.length,
        }
      })
      return ok({ customers })
    },
  }
}

module.exports = {
  createManualOrderReadService,
}
