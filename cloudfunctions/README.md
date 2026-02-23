# Cloud Functions

This mini program uses Tencent CloudBase (cloud development).

Functions:
- `auth`: get current `openid`, admin check
- `customer`: customer APIs (current sale, create order, my orders)
- `admin`: admin APIs (dishes, sale lifecycle, orders, export)

In WeChat DevTools:
1. Enable Cloud Development and select an environment.
2. Install dependencies per function folder (`npm install`).
3. Upload and deploy each function.

You must create/modify these documents in the database:
- `system_admins/main`
  - `adminOpenIds`: add your `openid` here to become admin
- `system_runtime_state/main`
  - `currentSaleId`: `null` initially (system will manage it)
- `delivery_rules/main`
  - `deliveryMinByCity`, `deliveryMinDefaultCents` (can start empty/default)

Tip: run cloud function `auth` action `getMyOpenId` to get your current `openid`.
