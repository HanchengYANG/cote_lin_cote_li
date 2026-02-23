# 开发环境重置数据库（清库重建）

本项目当前处于开发阶段，允许清空测试数据后重建结构。

## 1. 清理前确认

- 记录管理员 openid（后续要写回 `system_admins/main`）
- 记录当前需要保留的起送价规则（如有）
- 确认没有需要保留的测试订单数据

## 2. 新集合清单（最少）

请在云数据库创建以下集合：

- `system_admins`
- `system_runtime_state`
- `delivery_rules`
- `dishes`
- `sales`
- `sale_items`
- `sale_production_progress`
- `sale_fulfillment_plans`
- `orders`
- `customer_profiles`
- `customer_addresses`
- `order_audit_logs`

## 3. 初始化文档

### `system_admins/main`

```json
{
  "_id": "main",
  "adminOpenIds": []
}
```

把管理员 openid 填入 `adminOpenIds`。

### `system_runtime_state/main`

```json
{
  "_id": "main",
  "currentSaleId": null
}
```

### `delivery_rules/main`

```json
{
  "_id": "main",
  "defaultMinCents": null,
  "cityRules": []
}
```

## 4. 部署云函数

重置数据库后，重新部署：

- `admin`
- `customer`
- `auth`

（在微信开发者工具中选择“上传并部署：云端安装依赖”）

## 5. 重新编译小程序

- 重新编译
- 用店主账号先完成一次初始化流程（建菜、开单）

## 6. 常见问题

- `collection not exists`
  - 对应集合未创建
- 首页显示“暂无开单中”
  - 检查 `system_runtime_state/main.currentSaleId`
- 店主身份失效
  - 检查 `system_admins/main.adminOpenIds`

