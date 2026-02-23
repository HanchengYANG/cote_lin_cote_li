function createCustomerProfileRepo(deps) {
  const {
    db,
    _,
    getAllByPaging,
    normalizeStoredAddresses,
    sanitizeProfileNickname,
    normalizeProfilePhone,
    normalizePhone,
    toSafeInt,
  } = deps

  async function getCustomerProfileDoc(openId) {
    try {
      const r = await db.collection('customer_profiles').doc(openId).get()
      return r && r.data ? r.data : null
    } catch (err) {
      return null
    }
  }

  async function listCustomerAddressRows(openId) {
    if (!openId) return []
    try {
      return await getAllByPaging(
        (skip, limit) => db.collection('customer_addresses').where({ customerOpenId: openId }).skip(skip).limit(limit),
        { pageSize: 100 }
      )
    } catch (err) {
      return []
    }
  }

  function composeCustomerDoc(profileDoc, addressRows, openId) {
    const p = profileDoc && typeof profileDoc === 'object' ? profileDoc : {}
    return {
      _id: String((p && (p._id || p.openId)) || openId || '').trim(),
      nickname: String((p && p.nickname) || ''),
      profilePhone: String((p && p.profilePhone) || ''),
      defaultAddressId: String((p && p.defaultAddressId) || ''),
      addresses: normalizeStoredAddresses(addressRows),
      createdAt: (p && p.createdAt) || null,
      updatedAt: (p && p.updatedAt) || null,
    }
  }

  async function getCustomerDoc(openId) {
    const [profileDoc, addressRows] = await Promise.all([getCustomerProfileDoc(openId), listCustomerAddressRows(openId)])
    if (!profileDoc && (!addressRows || addressRows.length === 0)) return null
    return composeCustomerDoc(profileDoc, addressRows, openId)
  }

  async function ensureCustomerDoc(openId) {
    const existing = await getCustomerDoc(openId)
    if (existing) return existing
    const now = db.serverDate()
    await db.collection('customer_profiles').doc(openId).set({
      data: {
        openId,
        nickname: '',
        profilePhone: '',
        defaultAddressId: '',
        createdAt: now,
        updatedAt: now,
      },
    })
    return getCustomerDoc(openId)
  }

  async function getCustomerDocTx(tx, openId) {
    let profileDoc = null
    try {
      const got = await tx.collection('customer_profiles').doc(openId).get()
      profileDoc = got && got.data ? got.data : null
    } catch (err) {
      profileDoc = null
    }
    let addressRows = []
    try {
      const r = await tx.collection('customer_addresses').where({ customerOpenId: openId }).get()
      addressRows = (r && r.data) || []
    } catch (err) {
      addressRows = []
    }
    if (!profileDoc && addressRows.length === 0) return null
    return composeCustomerDoc(profileDoc, addressRows, openId)
  }

  async function saveCustomerDocTx(tx, openId, docLike) {
    const now = db.serverDate()
    const customer = docLike || {}
    const nickname = sanitizeProfileNickname(customer.nickname)
    const profilePhone = normalizeProfilePhone(customer.profilePhone)
    const addresses = normalizeStoredAddresses(customer.addresses)
    let defaultAddressId = String(customer.defaultAddressId || '').trim()
    if (!addresses.some((x) => x.id === defaultAddressId)) {
      defaultAddressId = addresses[0] ? addresses[0].id : ''
    }

    let profileExists = true
    let profileGet = null
    try {
      profileGet = await tx.collection('customer_profiles').doc(openId).get()
    } catch (err) {
      profileExists = false
    }
    const prevProfile = profileGet && profileGet.data ? profileGet.data : null
    const profileData = {
      openId,
      nickname,
      profilePhone,
      defaultAddressId,
      updatedAt: now,
    }
    if (profileExists && prevProfile) {
      await tx.collection('customer_profiles').doc(openId).update({ data: profileData })
    } else {
      await tx.collection('customer_profiles').doc(openId).set({
        data: {
          ...profileData,
          createdAt: now,
        },
      })
    }

    let existingRows = []
    try {
      const r = await tx.collection('customer_addresses').where({ customerOpenId: openId }).get()
      existingRows = (r && r.data) || []
    } catch (err) {
      existingRows = []
    }
    const existingIds = new Set(existingRows.map((x) => String((x && (x._id || x.id)) || '').trim()).filter(Boolean))
    const nextIds = new Set()
    for (const addr of addresses) {
      const addrId = String(addr.id || '').trim()
      if (!addrId) continue
      nextIds.add(addrId)
      const payload = {
        customerOpenId: openId,
        id: addrId,
        label: String(addr.label || '').trim(),
        line1: String(addr.line1 || '').trim(),
        line2: String(addr.line2 || '').trim(),
        postalCode: String(addr.postalCode || '').trim(),
        city: String(addr.city || '').trim(),
        phone: normalizePhone(addr.phone || ''),
        country: String(addr.country || 'FR').trim().toUpperCase() || 'FR',
        createdAtMs: toSafeInt(addr.createdAtMs, Date.now()),
        updatedAtMs: toSafeInt(addr.updatedAtMs, Date.now()),
        updatedAt: now,
      }
      if (existingIds.has(addrId)) {
        await tx.collection('customer_addresses').doc(addrId).update({ data: payload })
      } else {
        await tx.collection('customer_addresses').doc(addrId).set({
          data: {
            _id: addrId,
            ...payload,
            createdAt: now,
          },
        })
      }
    }
    for (const oldId of existingIds) {
      if (!nextIds.has(oldId)) {
        await tx.collection('customer_addresses').doc(oldId).remove()
      }
    }
  }

  return {
    getCustomerProfileDoc,
    listCustomerAddressRows,
    composeCustomerDoc,
    getCustomerDoc,
    ensureCustomerDoc,
    getCustomerDocTx,
    saveCustomerDocTx,
  }
}

module.exports = {
  createCustomerProfileRepo,
}
