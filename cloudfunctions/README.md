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

You must create/modify `adminConfig/main` in the database:
- `adminOpenIds`: add your `openid` here to become admin
- `activeSaleId`: keep `null` (system will manage it)

Tip: run cloud function `auth` action `getMyOpenId` to get your current `openid`.
