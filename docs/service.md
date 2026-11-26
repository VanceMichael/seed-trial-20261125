# 试种材料管理服务

本服务管理试种演练业务的材料责任：接收试验方案和站点申请，核准品种使用范围及所需许可，分批发种、确认播种并回收剩余材料。系统**不计算育种结论，不判断真实检疫合格**，受潮、身份、合格与否均以有权人员的明确决定为准。

## 角色与认证

所有业务请求用请求头 `X-User-Id: 用户编号` 标识操作人。首次启动先 `POST /bootstrap` 建立初始用户（仅在没有任何用户时可用）：

| 用户编号 | 角色 | 能做什么 |
| --- | --- | --- |
| u-approver | approver 核准人 | 登记许可与方案核准、隔离材料放行/销毁决定、采收交接核准、承诺重新核准、项目结清 |
| u-keeper | keeper 库管 | 建批、备货出库、交付回执、回收包到库与身份核实 |
| u-quality | quality 质量 | 受潮等质量事件登记、隔离、身份更正核实 |
| u-site-a / u-site-b | site 站点 | 只处理本站点的方案、验收、播种/留样/损耗/退回登记、采收登记 |

站点用户的任何请求都按其所属站点隔离，跨站点材料一律 403。新增站点用户走 `POST /admin/users`（核准人权限）。

## 计量口径

- 每个批次有基准计量 `baseUnit`：`grams`（克）或 `seeds`（粒），库存桶一律按基准计量记账。
- 克与粒是两套口径，**没有默认换算**。只有建批时登记了 `conversionBasis`（含 fromUnit/toUnit 与整数因子 factorNumerator/factorDenominator）的批次，才允许跨口径申请或登记，且换算结果必须是正整数。
- 站点登记播种、留样、损耗、退回的合计不能超过该站点真实接收的**可用量**；验收隔离量不在可用量内。

## 业务规则落点

| 规则 | 服务中的实现 |
| --- | --- |
| 科研用途放行不能用于商业推广 | 批次 `purpose` 与方案 `purpose` 必须一致；不一致在核准时 409 |
| 站点搬迁/换品种需重新核准，旧许可不沿用 | 方案要素变更后状态回到 `draft`；许可按 站点+品种+季+用途 精确匹配 |
| 申请人不能批准自己的申请 | 核准时比对 applicant 与当前用户，403 |
| 重复申请 | 同方案+同批次存在 submitted/approved 申请时拒绝 |
| 两个站点竞争同一批库存 | 已承诺量（committed）在核准时扣减，超库存 409 `stock_already_committed` |
| 批次身份更正 | 未发承诺转 `suspended_identity` 暂停；已播种记录保留并标记 `identityAffected`；核实后承诺须逐点重新核准 |
| 部分受潮 | 只隔离受影响数量到 quarantine 桶，其余合格部分不自动报废；放行/销毁必须核准人决定 |
| 运输封签/交付/验收分别确认 | shipment 有 prepared → in_transit → delivered → accepted 独立环节与封签字段 |
| 回执中断 | 状态 `receipt_interrupted`，库存留在在途桶，不能重新标成可发；恢复后走 receipt-resumptions |
| 发错点转送 | 必须核对目的点许可、生态区与原封样关系；封签不符或无许可一律拒绝，不允许单改地址 |
| 未验收/隔离不能播种 | 站点可用量只含验收通过部分，超量登记 409 |
| 终止不抹去播种事实 | 终止后播种记录保留；仅允许退回动作，其他田间动作拒绝 |
| 未用种子须回收或核准销毁才能结清 | `POST /plans/{id}/closures` 检查 openItems，有未结材料 409 |
| 回收包到库身份未核实 | 进 pendingReturn 隔离桶，核实通过才并入 available；不符转隔离待销毁 |
| 采收材料受原用途限制 | harvest 带 `restrictedPurpose` 与原播种批次关联；换包装保留关联；商业交接 409 |

## 接口一览（均为 JSON）

### 基础资料
- `POST /bootstrap` 建立初始用户
- `POST /admin/users` 新增用户（核准人）
- `POST /sites` / `GET /sites`；`POST /varieties` / `GET /varieties`
- `POST /permits` 登记许可；`POST /permits/{id}/revoke` 撤销；`GET /permits`

### 批次与质量/身份
- `POST /lots` 建批（品种、封样、可用数量、生态区、用途、可选换算依据）；`GET /lots`；`GET /lots/{id}`
- `POST /lots/quality-events` 受潮等事件隔离（source: available 或 siteUsable）
- `POST /lots/quarantine-decisions` 核准人对隔离部分 `release_usable` 或 `destroy`
- `POST /lots/identity-corrections` 开启身份更正（未发暂停、已播种标记）
- `POST /lots/identity-resolutions` 核实结束恢复批次
- `POST /commitments/reconfirm` 受影响承诺逐点重新核准
- `POST /lots/destructions` 经核准销毁（available / warehouse_quarantine / site_quarantine）
- `GET /lots/{id}/trace` 批次全量决定、库存桶与台账流水

### 方案
- `POST /plans` / `GET /plans`
- `POST /plans/{id}/approvals` 核准（校验许可）
- `POST /plans/{id}/amendments` 变更要素（换址/换品种后回草稿）
- `POST /plans/{id}/terminations` 终止（未发承诺解除回库，播种保留）
- `POST /plans/{id}/closures` 结清（有未结材料则 409 并返回 blockers）
- `GET /plans/{id}/materials` 按试验逐条查申请、承诺、运输、站点登记、回收、采收与未结条目

### 申请与发种
- `POST /applications` 站点/核准人代提发种申请
- `POST /applications/{id}/decisions` 核准（body: `{"decision":"approve|reject"}`）；自批 403
- `GET /applications`
- `POST /shipments` 库管按承诺备货分批（超承诺 409；备货即物理进入 preparedStock 桶，防止超卖）
- `POST /shipments/{id}/cancellations` 备货未出库前取消，实物退回可用桶、承诺预留同步解除
- `POST /shipments/{id}/dispatch` 出库（封签、承运回执，备货桶转在途，承诺 overlay 相应减少）
- `POST /shipments/{id}/delivery` 交付登记；body 带 `receiptInterrupted:true` 记回执中断
- `POST /shipments/{id}/receipt-resumptions` 回执恢复补登记
- `POST /shipments/{id}/acceptances` 站点实际验收（封签是否完好、实收数量；差额自动进站点隔离桶）
- `POST /shipments/{id}/forwards` 发错点转送（目的点许可+原封样校验）
- `GET /shipments`

### 站点动作与回收
- `POST /site-movements` 登记 `sow|retain|loss|return`；return 必须带封签并生成回收单
- `GET /sites/{id}/balance` 站点本站各批可用/隔离/留样/已播种
- `POST /recoveries/{id}/arrivals` 回收包到库（隔离，不入库）
- `POST /recoveries/{id}/identity-verifications` 身份核实（confirmed:true 才回可用库存）
- `POST /recoveries/{id}/destructions` 回收包经核准销毁
- `GET /recoveries`

### 采收材料
- `POST /harvests` 登记采收，关联原播种批次并继承用途限制
- `POST /harvests/{id}/repacks` 换包装（保留原批次关联）
- `POST /harvests/{id}/handovers` 核准交接，用途必须与原限制一致
- `GET /harvests`

### 责任查询
- `GET /materials/open` 全库未结材料逐条清单（带责任方，不是统计汇总）
- `GET /ledger` 全库实际材料流向台账
- `GET /health` 存活检查

## 库存桶与守恒

批次实物库存分桶记账，恒等式为：
`总量 = 可用 available + 备货 preparedStock + 库内隔离 quarantine + 在途 inTransit + 回收在途 returning + 到库待核实 pendingReturn + 站点可用 siteUsable + 站点隔离 siteQuarantine + 站点留样 siteRetained + 已播种 sown + 损耗 loss + 销毁 destroyed`。

`committed`（已承诺未出库）不是实物桶，而是压在 `available + preparedStock` 之上的预留 overlay，因此不重复计入总量；出库一笔，committed 同步减少一笔。受潮隔离或销毁库内可用部分时，不能动用已承诺 overlay 覆盖的数量。终止方案只解除承诺 overlay，不会把同一实物第二次加回可用桶。

## 错误响应

统一形如 `{"error":{"code":"...","message":"...","details":...}}`。常见 code：`forbidden`/`site_scope`（越权）、`permit_mismatch`（无许可）、`region_mismatch`（生态区不符）、`purpose_mismatch`（用途不符）、`self_approval`（自批）、`duplicate_application`、`stock_already_committed`、`stock_reserved`（动用已承诺库存）、`identity_hold`、`no_conversion_basis`、`exceeds_received`、`plan_has_open_materials`。

## 持久化

状态写在 `SEED_STATE` 指定的 JSON 文件（默认 `.local/seed-trial.json`），采用临时文件 + 原子替换。重启进程用同一文件即可恢复全部责任与流水。
