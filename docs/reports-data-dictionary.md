# Reports Data Dictionary

Detailed documentation of data sources, transformations, and WB API endpoints for each report section.

---

## Section 1: Воронка (Product Funnel)

**Sheet:** `Воронка` | **Endpoint:** `GET /api/export/perechen/voronka`

### Fields

| Column | DB Table.Column | Transformation |
|--------|----------------|----------------|
| Артикул | `products.nm_id` | Direct |
| Артикул продавца | `products.vendor_code` | Direct |
| Название | `products.name` | Direct |
| Дата | `product_analytics.date` | `YYYY-MM-DD` format |
| Показы (карточка) | `product_analytics.open_card_count` | Direct |
| Положили в корзину | `product_analytics.add_to_cart_count` | Direct |
| Конверсия в корзину, % | `product_analytics.conversion_to_cart` | Pre-computed: `(add_to_cart_count / open_card_count) * 100` |
| Заказали | `product_analytics.orders_count` | Direct |
| Конверсия в заказ, % | `product_analytics.conversion_to_order` | Pre-computed: `(orders_count / add_to_cart_count) * 100` |
| Сумма заказов | `product_analytics.orders_sum` | Direct |
| Выкупили | `product_analytics.buyouts_count` | Direct |
| Сумма выкупов | `product_analytics.buyouts_sum` | Direct |
| Отменили | `product_analytics.cancel_count` | Direct |
| Сумма отмен | `product_analytics.cancel_sum` | Direct |
| % Выкупа | Computed in report | `(buyouts_count / orders_count) * 100`, rounded 2dp |
| Цена | `products.final_price` | Direct |

### Data Source

**DB tables:** `products` (UNIQUE: `nm_id`), `product_analytics` (UNIQUE: `nm_id, date`)

**Sync commands:**
- `sync products` -> `POST content-api.wildberries.ru/content/v2/get/cards/list`
- `sync prices` -> `GET discounts-prices-api.wildberries.ru/api/v2/list/goods/filter`
- `sync analytics` -> `POST seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products`

**API response mapping:**
| API field | DB column |
|-----------|-----------|
| `statistic.selected.openCount` | `open_card_count` |
| `statistic.selected.cartCount` | `add_to_cart_count` |
| `statistic.selected.orderCount` | `orders_count` |
| `statistic.selected.orderSum` | `orders_sum` |
| `statistic.selected.buyoutCount` | `buyouts_count` |
| `statistic.selected.buyoutSum` | `buyouts_sum` |
| `statistic.selected.cancelCount` | `cancel_count` |
| `statistic.selected.cancelSum` | `cancel_sum` |

---

## Section 2: Лента заказов (Orders Feed)

**Sheet:** `Лента заказов` | **Endpoint:** `GET /api/export/perechen/orders`

### Fields

| Column | DB Table.Column | Transformation |
|--------|----------------|----------------|
| ID заказа | `orders.order_id` | Direct (derived from `srid`, first 15 digits) |
| Артикул | `orders.nm_id` | Direct |
| Дата создания | `orders.date_created` | `YYYY-MM-DD HH:mm` format |
| Дата обновления | `orders.date_updated` | `YYYY-MM-DD HH:mm` or empty |
| Склад | `orders.warehouse_name` | Direct |
| Регион | `orders.region` | Direct |
| Размер | `orders.size` | Direct |
| Бренд | `orders.brand` | Direct |
| Категория | `orders.category` | Direct |
| Предмет | `orders.subject` | Direct |
| Цена | `orders.price` | Direct |
| Скидка, % | `orders.discount_percent` | Direct |
| СПП, % | `orders.spp` | Direct |
| Цена со скидкой | `orders.price_with_disc` | Direct |
| К перечислению | `orders.finished_price` | Direct |
| Статус | `orders.status` | Direct |
| Отменён | `orders.is_cancel` | Boolean -> `'Да'` / `'Нет'` |
| Дней доставки | Computed in SQL | `DATEDIFF(date_updated, date_created)` |

### Data Source

**DB table:** `orders` (UNIQUE: `order_id`)

**Sync command:** `sync orders` -> `GET statistics-api.wildberries.ru/api/v1/supplier/orders?dateFrom=`

**Notes:** Max 5000 rows returned per report. Order ID derived from `srid` field (non-digit chars stripped, first 15 chars).

---

## Section 3: Остатки (Inventory)

**Sheet:** `Остатки` | **Endpoint:** `GET /api/export/perechen/stocks`

### Fields (single product mode)

| Column | DB Table.Column | Transformation |
|--------|----------------|----------------|
| Артикул | `stock_snapshots.nm_id` | Direct |
| Артикул продавца | `stock_snapshots.supplier_article` | Direct |
| Размер | `stock_snapshots.tech_size` | Direct |
| Баркод | `stock_snapshots.barcode` | Direct |
| Склад | `stock_snapshots.warehouse_name` | Direct |
| На складе | `stock_snapshots.quantity` | Direct |
| В пути к клиенту | `stock_snapshots.in_way_to_client` | Direct |
| В пути возврат | `stock_snapshots.in_way_from_client` | Direct |
| Полный остаток | `stock_snapshots.quantity_full` | Direct |
| Категория | `stock_snapshots.category` | Direct |
| Бренд | `stock_snapshots.brand` | Direct |
| Цена | `stock_snapshots.price` | Direct |
| Скидка | `stock_snapshots.discount` | Direct |
| Дата последнего изменения | `stock_snapshots.last_change_date` | `YYYY-MM-DD HH:mm` format |

### Fields (all products — summary mode)

| Column | Source | Transformation |
|--------|--------|----------------|
| Артикул | `nm_id` | GROUP BY |
| Артикул продавца | `supplier_article` | GROUP BY |
| Бренд | `brand` | GROUP BY |
| Предмет | `subject` | GROUP BY |
| На складе (всего) | `quantity` | `SUM()` |
| В пути к клиенту | `in_way_to_client` | `SUM()` |
| В пути возврат | `in_way_from_client` | `SUM()` |
| Полный остаток | `quantity_full` | `SUM()` |
| Складов | `warehouse_name` | `COUNT(DISTINCT)` |
| Размеров | `tech_size` | `COUNT(DISTINCT)` |

### Data Source

**DB table:** `stock_snapshots` (UNIQUE: `nm_id, tech_size, warehouse_name, snapshot_date`)

**Sync command:** `sync stocks` -> `GET statistics-api.wildberries.ru/api/v1/supplier/stocks?dateFrom=`

**Notes:** Uses latest `snapshot_date` only. Snapshot date = today's date at sync time.

---

## Section 4: Точки входа (Traffic Sources)

**Sheet:** `Точки входа` | **Endpoint:** `GET /api/export/perechen/traffic`

### Fields (single product mode)

| Column | DB Table.Column | Transformation |
|--------|----------------|----------------|
| Артикул | `traffic_source_analytics.nm_id` | Direct |
| Дата | `traffic_source_analytics.date` | `YYYY-MM-DD` format |
| Источник | `traffic_source_analytics.source_name` | Direct |
| Просмотры | `traffic_source_analytics.open_card_count` | Direct |
| В корзину | `traffic_source_analytics.add_to_cart_count` | Direct |
| Заказы | `traffic_source_analytics.orders_count` | Direct |
| Сумма заказов | `traffic_source_analytics.orders_sum` | Direct |
| Выкупы | `traffic_source_analytics.buyouts_count` | Direct |
| Отмены | `traffic_source_analytics.cancel_count` | Direct |

### Fields (all products — summary mode)

Same as above plus:

| Column | Source | Transformation |
|--------|--------|----------------|
| Название | `products.name` | Direct |
| Конверсия в корзину, % | SQL computed | `SUM(add_to_cart) / NULLIF(SUM(open_card), 0) * 100` |
| Конверсия в заказ, % | SQL computed | `SUM(orders) / NULLIF(SUM(add_to_cart), 0) * 100` |

### Source Name Values

| API key | source_name |
|---------|-------------|
| (aggregate) | `total` |
| `openBySearch` | `Поиск` |
| `openByAdvert` | `Реклама` |
| `openByRecommend` | `Рекомендации` |
| `openByCategory` | `Каталог/Категория` |
| `openByUrl` | `Прямая ссылка` |
| `openByCart` | `Корзина` |
| `openByOther` | `Прочее` |

### Data Source

**DB table:** `traffic_source_analytics` (UNIQUE: `nm_id, date, source_name`)

**Sync command:** `sync traffic` -> `POST seller-analytics-api.wildberries.ru/api/analytics/v3/sales-funnel/products`

**Notes:** Per-source rows only have `open_card_count` populated; cart/order/buyout fields are 0 (WB API doesn't break those down by source). The `total` row has all fields populated.

---

## Section 5: Маркетинг (Marketing Events)

**Sheet:** `Маркетинг` | **Endpoint:** `GET /api/export/perechen/marketing`

### Fields

| Column | DB Table.Column | Transformation |
|--------|----------------|----------------|
| Артикул | `marketing_events.nm_id` | Direct |
| Дата | `marketing_events.event_date` | `YYYY-MM-DD` format |
| Тип события | `marketing_events.event_type` | Label mapping (see below) |
| Описание | `marketing_events.description` | Direct |
| Дата создания | `marketing_events.created_at` | `YYYY-MM-DD HH:mm` format |

### Event Type Labels

| DB value | Display label |
|----------|--------------|
| `price_change` | Изменение цены |
| `photo_update` | Обновление фото |
| `description_update` | Обновление описания |
| `promotion_start` | Начало акции |
| `promotion_end` | Конец акции |
| `seo_update` | SEO обновление |
| `new_review_response` | Ответ на отзыв |
| `stock_replenishment` | Пополнение склада |
| `other` | Другое |

### Data Source

**DB table:** `marketing_events` (no unique constraint — multiple events per day allowed)

**No automatic sync.** Events are created manually via `POST /api/events` from the dashboard UI.

---

## Section 6: Рекламные компании (Ad Campaigns)

**Sheet:** `Рекламные компании` | **Endpoint:** `GET /api/export/perechen/campaigns`

### Fields

| Column | DB Table.Column | Transformation |
|--------|----------------|----------------|
| ID | `campaigns.campaign_id` | Direct |
| Название | `campaigns.name` | Direct |
| Тип | `campaigns.type` | Pre-mapped at sync (see below) |
| Статус | `campaigns.status` | Pre-mapped at sync (see below) |
| Дневной бюджет | `campaigns.daily_budget` | Direct |
| Дата | `campaign_stats.date` | `YYYY-MM-DD` format |
| Показы | `campaign_stats.views` | Direct |
| Клики | `campaign_stats.clicks` | Direct |
| CTR, % | `campaign_stats.ctr` | Pre-computed: `(clicks / views) * 100` |
| CPC | `campaign_stats.cpc` | Pre-computed: `spend / clicks` |
| CPM | `campaign_stats.cpm` | Pre-computed: weighted avg by views across apps |
| Расход | `campaign_stats.spend` | Direct |
| Заказы | `campaign_stats.orders` | Direct |
| Сумма заказов | `campaign_stats.order_sum` | Direct |
| ROAS | Computed in report | `order_sum / spend`, rounded 2dp (0 if spend=0) |

### Campaign Type Mapping

| WB code | Display |
|---------|---------|
| 4 | Каталог |
| 5 | Карточка товара |
| 6 | Поиск |
| 7 | Рекомендации |
| 8 | Авто |
| 9 | Поиск + каталог |

### Campaign Status Mapping

| WB code | Display |
|---------|---------|
| 9 | Активна |
| 11 | Приостановлена |
| 7 | Завершена |

### Data Source

**DB tables:** `campaigns` (UNIQUE: `campaign_id`), `campaign_stats` (UNIQUE: `campaign_id, date`)

**Sync commands:**
- `sync campaigns` -> `GET advert-api.wildberries.ru/adv/v1/promotion/count`
- `sync stats` -> `POST advert-api.wildberries.ru/adv/v2/fullstats`

**Notes:** Stats response contains `days[]` array per campaign, each day with `apps[]` array. All apps are summed per day for views/clicks/spend/orders. CPM is weighted-averaged by views across apps.

---

## Section 7: Кластеры (Keywords / Search Analytics)

**Sheet:** `Кластеры` | **Endpoint:** `GET /api/export/perechen/clusters`

Uses **two data paths** with automatic fallback.

### Primary Path — `search_query_analytics`

Used when search analytics data exists (synced from WB Seller Analytics).

| Column | DB Column | SQL Aggregation | Transformation |
|--------|-----------|-----------------|----------------|
| Артикул | `nm_id` | GROUP BY | Direct |
| Ключевой запрос | `keyword` | GROUP BY | Direct |
| Ср. позиция | `avg_position` | `ROUND(AVG(), 1)` | Average across dates |
| Показы | `impressions` | `SUM()` | Cast to Number (MySQL DECIMAL fix) |
| Переходы | `card_visits` | `SUM()` | Cast to Number |
| CTR, % | `ctr` | `ROUND(AVG() * 100, 2)` | Stored as 0-1 decimal, displayed as % |
| В корзину | `cart_adds` | `SUM()` | Cast to Number |
| Заказы | `orders_count` | `SUM()` | Cast to Number |
| Видимость, % | `visibility` | `ROUND(AVG() * 100, 2)` | Stored as 0-1 decimal, displayed as % |

**DB table:** `search_query_analytics` (UNIQUE: `nm_id, keyword(255), date`)

**Sync command:** `sync search-queries` -> `POST seller-analytics-api.wildberries.ru/api/v2/search-report/product/search-texts`

**API response mapping:**
| API field | DB column |
|-----------|-----------|
| `text` / `keyword` / `query` | `keyword` |
| `avgPosition` / `position` | `avg_position` |
| `openCard` / `impressions` | `impressions` |
| `ctr` | `ctr` |
| `openCard` / `cardVisits` | `card_visits` |
| `addToCart` / `cartAdds` | `cart_adds` |
| `orders` / `ordersCount` | `orders_count` |
| `visibility` | `visibility` |

### Fallback Path — `keyword_collections` + `keyword_positions`

Used when `search_query_analytics` has no data for the requested period.

| Column | Source | Notes |
|--------|--------|-------|
| Артикул | `keyword_collections.nm_id` | Direct |
| Ключевой запрос | `keyword_collections.keyword` | Direct |
| Ср. позиция | `keyword_positions.position` | Latest check only (LIMIT 1) |
| Показы | `keyword_collections.frequency` | Manual/estimated value |
| Переходы | — | `'-'` (not available) |
| CTR, % | — | `'-'` (not available) |
| В корзину | — | `'-'` (not available) |
| Заказы | — | `'-'` (not available) |
| Видимость, % | — | `'-'` (not available) |

**No automatic sync.** Keywords added manually via `POST /api/keywords`. Positions tracked by keyword-tracker service.

---

## WB API Endpoints Summary

| Section | WB Base URL | Endpoint | Method |
|---------|-------------|----------|--------|
| Воронка (analytics) | `seller-analytics-api.wildberries.ru` | `/api/analytics/v3/sales-funnel/products` | POST |
| Воронка (products) | `content-api.wildberries.ru` | `/content/v2/get/cards/list` | POST |
| Воронка (prices) | `discounts-prices-api.wildberries.ru` | `/api/v2/list/goods/filter` | GET |
| Лента заказов | `statistics-api.wildberries.ru` | `/api/v1/supplier/orders?dateFrom=` | GET |
| Остатки | `statistics-api.wildberries.ru` | `/api/v1/supplier/stocks?dateFrom=` | GET |
| Точки входа | `seller-analytics-api.wildberries.ru` | `/api/analytics/v3/sales-funnel/products` | POST |
| Маркетинг | — | Manual input only | — |
| Кампании (list) | `advert-api.wildberries.ru` | `/adv/v1/promotion/count` | GET |
| Кампании (stats) | `advert-api.wildberries.ru` | `/adv/v2/fullstats` | POST |
| Кластеры | `seller-analytics-api.wildberries.ru` | `/api/v2/search-report/product/search-texts` | POST |

## Sync CLI Commands

All sync commands run via: `docker exec wb-analytics-app bun run src/cli/sync.ts <command>`

| Command | Populates Table | Used By Section |
|---------|----------------|-----------------|
| `products` | `products` | Воронка, Точки входа |
| `prices` | `products` (price fields) | Воронка |
| `analytics` | `product_analytics` | Воронка |
| `orders` | `orders` | Лента заказов |
| `stocks` | `stock_snapshots` | Остатки |
| `traffic` | `traffic_source_analytics` | Точки входа |
| `campaigns` | `campaigns` | Рекламные компании |
| `stats` | `campaign_stats` | Рекламные компании |
| `search-queries` | `search_query_analytics` | Кластеры |
| `all` | All of the above | All sections |
