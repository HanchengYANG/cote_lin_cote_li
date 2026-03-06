function buildCustomerSearchText(row) {
  return [
    String((row && row.nickname) || '').trim(),
    String((row && row.defaultPhone) || '').trim(),
    String((row && row.profilePhone) || '').trim(),
    ...(Array.isArray(row && row.addressPhones) ? row.addressPhones.map((x) => String(x || '').trim()) : []),
    String((row && row.customerOpenId) || '').trim(),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function toEpochMs(input) {
  if (!input) return 0
  if (typeof input === 'number' && Number.isFinite(input)) return input
  const t = new Date(input).getTime()
  return Number.isFinite(t) ? t : 0
}

function sortCustomerProfiles(rows) {
  return (Array.isArray(rows) ? rows.slice() : []).sort((a, b) => {
    const ta = toEpochMs((a && (a.updatedAt || a.createdAt)) || 0)
    const tb = toEpochMs((b && (b.updatedAt || b.createdAt)) || 0)
    return tb - ta
  })
}

function buildCustomerSummary(profile, addressesByOpenId, pickDefaultPhone, normalizePhone) {
  const customerOpenId = String((profile && profile._id) || '').trim()
  const nickname = String((profile && profile.nickname) || '').trim()
  const addresses = (addressesByOpenId && addressesByOpenId.get(customerOpenId)) || []
  const defaultAddressId = String((profile && profile.defaultAddressId) || '').trim()
  const defaultAddress = addresses.find((x) => String((x && x.id) || '').trim() === defaultAddressId) || addresses[0] || null
  const addressPhones = Array.from(
    new Set(
      addresses
        .map((addr) => normalizePhone(addr && addr.phone))
        .filter(Boolean)
    )
  )
  const summary = {
    customerOpenId,
    nickname,
    isManualCreated: !!(profile && profile.isManualCreated),
    defaultPhone: pickDefaultPhone(addresses, defaultAddressId),
    profilePhone: normalizePhone(profile && profile.profilePhone),
    addressCount: addresses.length,
    defaultAddressText: defaultAddress
      ? [defaultAddress.line1, defaultAddress.line2, defaultAddress.postalCode, defaultAddress.city, defaultAddress.country]
          .filter(Boolean)
          .join(', ')
      : '',
    updatedAt: (profile && profile.updatedAt) || null,
    searchText: '',
    addressPhones,
  }
  summary.searchText = buildCustomerSearchText(summary)
  return summary
}

function serializeCustomerSummary(summary) {
  const { addressPhones, ...rest } = summary || {}
  return rest
}

function matchesCustomerKeyword(summary, keywordText, keywordDigits) {
  const searchText = String((summary && summary.searchText) || '').toLowerCase()
  if (keywordText && searchText.includes(keywordText)) return true
  return !!(keywordDigits && searchText.includes(keywordDigits))
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
        return sortCustomerProfiles(rows).slice(0, max)
      } catch (err2) {
        return []
      }
    }
  }

  async function listCustomerProfilesPage(limit = 40, offset = 0) {
    const max = Math.max(1, Math.min(100, Number(limit || 40) || 40))
    const skip = Math.max(0, Number(offset || 0) || 0)
    try {
      const r = await db.collection('customer_profiles').orderBy('updatedAt', 'desc').skip(skip).limit(max + 1).get()
      const rows = Array.isArray(r && r.data) ? r.data : []
      const hasMore = rows.length > max
      const pageRows = hasMore ? rows.slice(0, max) : rows
      return {
        rows: pageRows,
        hasMore,
        nextOffset: skip + pageRows.length,
      }
    } catch (err) {
      try {
        const rows = await getAllByPaging((pageSkip, pageLimit) => db.collection('customer_profiles').skip(pageSkip).limit(pageLimit), {
          pageSize: 100,
        })
        const sorted = sortCustomerProfiles(rows)
        const pageRows = sorted.slice(skip, skip + max)
        return {
          rows: pageRows,
          hasMore: skip + max < sorted.length,
          nextOffset: skip + pageRows.length,
        }
      } catch (err2) {
        return {
          rows: [],
          hasMore: false,
          nextOffset: skip,
        }
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
        try {
          console.warn('[manual-order-read] query OPEN sale with orderBy failed, fallback to in-memory sort', err && err.message)
          const r2 = await db.collection('sales').where({ status: 'OPEN' }).limit(20).get()
          const rows = Array.isArray(r2 && r2.data) ? r2.data.slice() : []
          rows.sort((a, b) => {
            const ta = new Date((a && a.createdAt) || 0).getTime() || 0
            const tb = new Date((b && b.createdAt) || 0).getTime() || 0
            return tb - ta
          })
          openSale = rows[0] || null
        } catch (err2) {
          console.warn('[manual-order-read] fallback query OPEN sale failed', err2 && err2.message)
          openSale = null
        }
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
      const recentCustomers = recentProfiles.map((c) =>
        serializeCustomerSummary(buildCustomerSummary(c, addressesByOpenId, pickDefaultPhone, normalizePhone))
      )

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
      const keywordDigits = normalizePhone(keyword)
      const max = Math.max(1, Math.min(100, Number((event && event.limit) || 40) || 40))
      const offset = Math.max(0, Number((event && event.offset) || 0) || 0)

      if (!keyword) {
        const paged = await listCustomerProfilesPage(max, offset)
        const ids = paged.rows.map((c) => String((c && c._id) || '').trim()).filter(Boolean)
        const addressRows = await getCustomerAddressesByOpenIds(ids)
        const addressesByOpenId = buildAddressMapByOpenId(addressRows)
        const customers = paged.rows.map((c) =>
          serializeCustomerSummary(buildCustomerSummary(c, addressesByOpenId, pickDefaultPhone, normalizePhone))
        )
        return ok({
          customers,
          hasMore: !!paged.hasMore,
          nextOffset: Number(paged.nextOffset || 0),
        })
      }

      let rows = []
      try {
        rows = await getAllByPaging((skip, limit) => db.collection('customer_profiles').skip(skip).limit(limit), {
          pageSize: 100,
        })
      } catch (err) {
        rows = []
      }
      const sortedProfiles = sortCustomerProfiles(rows)
      const ids = sortedProfiles.map((c) => String((c && c._id) || '').trim()).filter(Boolean)
      const addressRows = await getCustomerAddressesByOpenIds(ids)
      const addressesByOpenId = buildAddressMapByOpenId(addressRows)
      const matchedCustomers = sortedProfiles
        .map((c) => buildCustomerSummary(c, addressesByOpenId, pickDefaultPhone, normalizePhone))
        .filter((summary) => matchesCustomerKeyword(summary, keyword, keywordDigits))
      const pageRows = matchedCustomers.slice(offset, offset + max)
      return ok({
        customers: pageRows.map(serializeCustomerSummary),
        hasMore: offset + max < matchedCustomers.length,
        nextOffset: offset + pageRows.length,
      })
    },
  }
}

module.exports = {
  createManualOrderReadService,
}
