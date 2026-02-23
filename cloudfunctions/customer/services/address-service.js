function createAddressService(deps) {
  const {
    db,
    ok,
    fail,
    buildAddressId,
    normalizeAddressPayload,
    normalizeStoredAddresses,
    sanitizeProfileNickname,
    normalizeProfilePhone,
    toProfileOutput,
    buildDeliveryMinRule,
    attachMinOrderInfo,
    getOrCreateAdminConfig,
    getCustomerDocTx,
    saveCustomerDocTx,
    throwBiz,
  } = deps

  return {
    async completeMyProfile(event, ctx) {
      const openId = ctx && ctx.openId
      const nickname = sanitizeProfileNickname(event.nickname)
      const address = normalizeAddressPayload(event.address, { requireLabel: true })
      if (!nickname) return fail('BAD_REQUEST', '缺少昵称')
      if (!address) return fail('INVALID_ADDRESS', '地址格式不正确')
      let profile = null
      try {
        profile = await db.runTransaction(async (tx) => {
          const customer = await getCustomerDocTx(tx, openId)
          const oldAddresses = normalizeStoredAddresses(customer && customer.addresses)
          const profilePhone = normalizeProfilePhone(customer && customer.profilePhone)
          const nowMs = Date.now()
          let addresses = oldAddresses
          let matched = oldAddresses.find((x) => {
            return x.line1 === address.line1 && x.line2 === address.line2 && x.postalCode === address.postalCode && x.city === address.city
          })
          if (!matched) {
            matched = {
              id: buildAddressId(),
              ...address,
              createdAtMs: nowMs,
              updatedAtMs: nowMs,
            }
            addresses = oldAddresses.concat([matched])
          } else {
            addresses = oldAddresses.map((x) => {
              if (x.id !== matched.id) return x
              return {
                ...x,
                ...address,
                updatedAtMs: nowMs,
              }
            })
            matched = addresses.find((x) => x.id === matched.id) || matched
          }
          const defaultAddressId = matched.id
          const saveData = {
            nickname,
            profilePhone,
            addresses,
            defaultAddressId,
            updatedAt: db.serverDate(),
          }
          await saveCustomerDocTx(tx, openId, saveData)
          return toProfileOutput({ nickname, profilePhone, addresses, defaultAddressId })
        })
      } catch (err) {
        return fail('TX_FAILED', '保存资料失败', String(err && err.message))
      }
      const cfg = await getOrCreateAdminConfig()
      return ok({ profile: attachMinOrderInfo(profile, buildDeliveryMinRule(cfg)) })
    },

    async addMyAddress(event, ctx) {
      const openId = ctx && ctx.openId
      const address = normalizeAddressPayload(event.address, { requireLabel: true })
      if (!address) return fail('INVALID_ADDRESS', '地址格式不正确')
      const setDefault = !!event.setDefault
      let profile = null
      try {
        profile = await db.runTransaction(async (tx) => {
          const customer = await getCustomerDocTx(tx, openId)
          const nickname = sanitizeProfileNickname(customer && customer.nickname)
          const profilePhone = normalizeProfilePhone(customer && customer.profilePhone)
          const oldAddresses = normalizeStoredAddresses(customer && customer.addresses)
          const nowMs = Date.now()
          const newAddr = {
            id: buildAddressId(),
            ...address,
            createdAtMs: nowMs,
            updatedAtMs: nowMs,
          }
          const addresses = oldAddresses.concat([newAddr])
          let defaultAddressId = String((customer && customer.defaultAddressId) || '').trim()
          if (!addresses.some((x) => x.id === defaultAddressId)) defaultAddressId = ''
          if (setDefault || !defaultAddressId) defaultAddressId = newAddr.id
          const saveData = {
            nickname,
            profilePhone,
            addresses,
            defaultAddressId,
            updatedAt: db.serverDate(),
          }
          await saveCustomerDocTx(tx, openId, saveData)
          return toProfileOutput({ nickname, profilePhone, addresses, defaultAddressId })
        })
      } catch (err) {
        return fail('TX_FAILED', '保存地址失败', String(err && err.message))
      }
      const cfg = await getOrCreateAdminConfig()
      return ok({ profile: attachMinOrderInfo(profile, buildDeliveryMinRule(cfg)) })
    },

    async updateMyAddress(event, ctx) {
      const openId = ctx && ctx.openId
      const addressId = String(event.addressId || '').trim()
      const address = normalizeAddressPayload(event.address, { requireLabel: true })
      if (!addressId) return fail('BAD_REQUEST', '缺少 addressId')
      if (!address) return fail('INVALID_ADDRESS', '地址格式不正确')
      const setDefault = !!event.setDefault
      let profile = null
      try {
        profile = await db.runTransaction(async (tx) => {
          const customer = await getCustomerDocTx(tx, openId)
          if (!customer) throwBiz('BAD_REQUEST', '请先完善资料')
          const nickname = sanitizeProfileNickname(customer.nickname)
          const profilePhone = normalizeProfilePhone(customer.profilePhone)
          const oldAddresses = normalizeStoredAddresses(customer.addresses)
          let found = false
          const nowMs = Date.now()
          const addresses = oldAddresses.map((x) => {
            if (x.id !== addressId) return x
            found = true
            return {
              ...x,
              ...address,
              updatedAtMs: nowMs,
            }
          })
          if (!found) throwBiz('ADDRESS_NOT_FOUND', '地址不存在')
          let defaultAddressId = String(customer.defaultAddressId || '').trim()
          if (!addresses.some((x) => x.id === defaultAddressId)) defaultAddressId = addresses[0] ? addresses[0].id : ''
          if (setDefault) defaultAddressId = addressId
          await saveCustomerDocTx(tx, openId, {
            nickname,
            profilePhone,
            addresses,
            defaultAddressId,
          })
          return toProfileOutput({ nickname, profilePhone, addresses, defaultAddressId })
        })
      } catch (err) {
        if (err && err.code) return fail(err.code, err.message || '保存地址失败', err.detail)
        return fail('TX_FAILED', '保存地址失败', String(err && err.message))
      }
      const cfg = await getOrCreateAdminConfig()
      return ok({ profile: attachMinOrderInfo(profile, buildDeliveryMinRule(cfg)) })
    },

    async deleteMyAddress(event, ctx) {
      const openId = ctx && ctx.openId
      const addressId = String(event.addressId || '').trim()
      if (!addressId) return fail('BAD_REQUEST', '缺少 addressId')
      let profile = null
      try {
        profile = await db.runTransaction(async (tx) => {
          const customer = await getCustomerDocTx(tx, openId)
          if (!customer) throwBiz('BAD_REQUEST', '请先完善资料')
          const nickname = sanitizeProfileNickname(customer.nickname)
          const profilePhone = normalizeProfilePhone(customer.profilePhone)
          const oldAddresses = normalizeStoredAddresses(customer.addresses)
          const addresses = oldAddresses.filter((x) => x.id !== addressId)
          if (addresses.length === oldAddresses.length) throwBiz('ADDRESS_NOT_FOUND', '地址不存在')
          let defaultAddressId = String(customer.defaultAddressId || '').trim()
          if (defaultAddressId === addressId || !addresses.some((x) => x.id === defaultAddressId)) {
            defaultAddressId = addresses[0] ? addresses[0].id : ''
          }
          await saveCustomerDocTx(tx, openId, {
            nickname,
            profilePhone,
            addresses,
            defaultAddressId,
          })
          return toProfileOutput({ nickname, profilePhone, addresses, defaultAddressId })
        })
      } catch (err) {
        if (err && err.code) return fail(err.code, err.message || '删除地址失败', err.detail)
        return fail('TX_FAILED', '删除地址失败', String(err && err.message))
      }
      const cfg = await getOrCreateAdminConfig()
      return ok({ profile: attachMinOrderInfo(profile, buildDeliveryMinRule(cfg)) })
    },

    async setDefaultAddress(event, ctx) {
      const openId = ctx && ctx.openId
      const addressId = String(event.addressId || '').trim()
      if (!addressId) return fail('BAD_REQUEST', '缺少 addressId')
      let profile = null
      try {
        profile = await db.runTransaction(async (tx) => {
          const customer = await getCustomerDocTx(tx, openId)
          if (!customer) throwBiz('BAD_REQUEST', '请先完善资料')
          const nickname = sanitizeProfileNickname(customer.nickname)
          const profilePhone = normalizeProfilePhone(customer.profilePhone)
          const addresses = normalizeStoredAddresses(customer.addresses)
          if (!addresses.some((x) => x.id === addressId)) throwBiz('ADDRESS_NOT_FOUND', '地址不存在')
          await saveCustomerDocTx(tx, openId, {
            nickname,
            profilePhone,
            addresses,
            defaultAddressId: addressId,
          })
          return toProfileOutput({ nickname, profilePhone, addresses, defaultAddressId: addressId })
        })
      } catch (err) {
        if (err && err.code) return fail(err.code, err.message || '设置默认地址失败', err.detail)
        return fail('TX_FAILED', '设置默认地址失败', String(err && err.message))
      }
      const cfg = await getOrCreateAdminConfig()
      return ok({ profile: attachMinOrderInfo(profile, buildDeliveryMinRule(cfg)) })
    },
  }
}

module.exports = {
  createAddressService,
}
