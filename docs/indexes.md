# 数据库索引清单（开发环境）

以下索引用于当前重构后的数据模型（`sale_items` / `customer_profiles` / `customer_addresses` / `system_*`）。

## `orders`

- `(saleId, status, createdAt)`
- `(saleId, fulfillmentType, status, createdAt)`
- `(customerOpenId, saleId, status)`
- `(customerOpenId, updatedAt)`

## `sales`

- `(status, createdAt)`
- `(updatedAt)`

## `sale_items`

- `(saleId, dishId)`
- `(saleId, sortOrder)`

## `customer_addresses`

- `(customerOpenId, createdAt)`

## `order_audit_logs`

- `(orderId, at)`
- `(saleId, at)`

## 说明

- 统计、复盘、履约完成校验依赖按 `saleId` 的订单查询，`orders` 索引优先级最高。
- `sale_items` 是当前 sale 配置与库存主来源，必须建立 `saleId` 相关索引。
- 如开发工具环境不支持复合索引批量创建，先建 `orders` 的两条 `saleId` 索引。

