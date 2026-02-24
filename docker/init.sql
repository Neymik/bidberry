-- WB Analytics Database Schema

-- Таблица рекламных кампаний
CREATE TABLE IF NOT EXISTS campaigns (
    id INT AUTO_INCREMENT PRIMARY KEY,
    campaign_id BIGINT UNIQUE NOT NULL,
    name VARCHAR(255),
    type VARCHAR(50),
    status VARCHAR(50),
    start_date DATETIME,
    end_date DATETIME,
    daily_budget DECIMAL(15, 2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_campaign_id (campaign_id),
    INDEX idx_status (status)
);

-- Таблица ставок (bidding)
CREATE TABLE IF NOT EXISTS bids (
    id INT AUTO_INCREMENT PRIMARY KEY,
    campaign_id BIGINT NOT NULL,
    keyword VARCHAR(500),
    bid DECIMAL(15, 2),
    position INT,
    cpm DECIMAL(15, 2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE CASCADE,
    INDEX idx_campaign (campaign_id),
    INDEX idx_keyword (keyword(255))
);

-- Таблица статистики кампаний
CREATE TABLE IF NOT EXISTS campaign_stats (
    id INT AUTO_INCREMENT PRIMARY KEY,
    campaign_id BIGINT NOT NULL,
    date DATE NOT NULL,
    views INT DEFAULT 0,
    clicks INT DEFAULT 0,
    ctr DECIMAL(10, 4) DEFAULT 0,
    cpc DECIMAL(15, 2) DEFAULT 0,
    cpm DECIMAL(15, 2) DEFAULT 0,
    spend DECIMAL(15, 2) DEFAULT 0,
    orders INT DEFAULT 0,
    order_sum DECIMAL(15, 2) DEFAULT 0,
    atbs INT DEFAULT 0,
    shks INT DEFAULT 0,
    sum_price DECIMAL(15, 2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE CASCADE,
    UNIQUE KEY unique_campaign_date (campaign_id, date),
    INDEX idx_date (date)
);

-- Таблица товаров
CREATE TABLE IF NOT EXISTS products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nm_id BIGINT UNIQUE NOT NULL,
    vendor_code VARCHAR(100),
    brand VARCHAR(255),
    subject VARCHAR(255),
    name VARCHAR(500),
    price DECIMAL(15, 2),
    discount INT,
    final_price DECIMAL(15, 2),
    rating DECIMAL(3, 2),
    feedbacks INT DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_nm_id (nm_id),
    INDEX idx_brand (brand),
    INDEX idx_subject (subject)
);

-- Таблица аналитики по товарам
CREATE TABLE IF NOT EXISTS product_analytics (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nm_id BIGINT NOT NULL,
    date DATE NOT NULL,
    open_card_count INT DEFAULT 0,
    add_to_cart_count INT DEFAULT 0,
    orders_count INT DEFAULT 0,
    orders_sum DECIMAL(15, 2) DEFAULT 0,
    buyouts_count INT DEFAULT 0,
    buyouts_sum DECIMAL(15, 2) DEFAULT 0,
    cancel_count INT DEFAULT 0,
    cancel_sum DECIMAL(15, 2) DEFAULT 0,
    conversion_to_cart DECIMAL(10, 4) DEFAULT 0,
    conversion_to_order DECIMAL(10, 4) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (nm_id) REFERENCES products(nm_id) ON DELETE CASCADE,
    UNIQUE KEY unique_product_date (nm_id, date),
    INDEX idx_date (date)
);

-- Таблица ключевых слов и позиций
CREATE TABLE IF NOT EXISTS keyword_positions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nm_id BIGINT NOT NULL,
    keyword VARCHAR(500) NOT NULL,
    position INT,
    page INT,
    frequency INT,
    checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (nm_id) REFERENCES products(nm_id) ON DELETE CASCADE,
    INDEX idx_keyword (keyword(255)),
    INDEX idx_nm_id (nm_id),
    INDEX idx_checked_at (checked_at)
);

-- Таблица истории импортов
CREATE TABLE IF NOT EXISTS import_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    import_type VARCHAR(50) NOT NULL,
    file_name VARCHAR(255),
    records_count INT DEFAULT 0,
    status VARCHAR(50) DEFAULT 'pending',
    error_message TEXT,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL
);

-- Коллекции ключевых слов для отслеживания
CREATE TABLE IF NOT EXISTS keyword_collections (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nm_id BIGINT NOT NULL,
    keyword VARCHAR(500) NOT NULL,
    frequency INT DEFAULT 0,
    is_tracked BOOLEAN DEFAULT TRUE,
    source VARCHAR(50) DEFAULT 'manual',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (nm_id) REFERENCES products(nm_id) ON DELETE CASCADE,
    UNIQUE KEY unique_product_keyword (nm_id, keyword(255)),
    INDEX idx_nm_id (nm_id),
    INDEX idx_tracked (is_tracked)
);

-- Себестоимость и расходы по товарам
CREATE TABLE IF NOT EXISTS product_costs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nm_id BIGINT NOT NULL,
    cost_price DECIMAL(15, 2) DEFAULT 0,
    logistics_cost DECIMAL(15, 2) DEFAULT 0,
    commission_pct DECIMAL(5, 2) DEFAULT 0,
    storage_cost DECIMAL(15, 2) DEFAULT 0,
    packaging_cost DECIMAL(15, 2) DEFAULT 0,
    additional_cost DECIMAL(15, 2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (nm_id) REFERENCES products(nm_id) ON DELETE CASCADE,
    UNIQUE KEY unique_product_cost (nm_id)
);

-- Отчёты по продажам от WB
CREATE TABLE IF NOT EXISTS sales_reports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nm_id BIGINT NOT NULL,
    date DATE NOT NULL,
    quantity INT DEFAULT 0,
    revenue DECIMAL(15, 2) DEFAULT 0,
    returns_count INT DEFAULT 0,
    returns_sum DECIMAL(15, 2) DEFAULT 0,
    wb_commission DECIMAL(15, 2) DEFAULT 0,
    logistics_cost DECIMAL(15, 2) DEFAULT 0,
    storage_cost DECIMAL(15, 2) DEFAULT 0,
    penalties DECIMAL(15, 2) DEFAULT 0,
    additional_charges DECIMAL(15, 2) DEFAULT 0,
    net_payment DECIMAL(15, 2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (nm_id) REFERENCES products(nm_id) ON DELETE CASCADE,
    UNIQUE KEY unique_sales_date (nm_id, date),
    INDEX idx_date (date)
);

-- Правила автоставок (Smart Bidder)
CREATE TABLE IF NOT EXISTS bid_rules (
    id INT AUTO_INCREMENT PRIMARY KEY,
    campaign_id BIGINT NOT NULL,
    keyword VARCHAR(500),
    strategy VARCHAR(50) NOT NULL,
    target_value DECIMAL(15, 2),
    min_bid DECIMAL(15, 2) DEFAULT 50,
    max_bid DECIMAL(15, 2) DEFAULT 1000,
    step DECIMAL(15, 2) DEFAULT 10,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE CASCADE,
    INDEX idx_campaign (campaign_id),
    INDEX idx_active (is_active)
);

-- Журнал изменений ставок
CREATE TABLE IF NOT EXISTS bid_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    campaign_id BIGINT NOT NULL,
    keyword VARCHAR(500),
    old_bid DECIMAL(15, 2),
    new_bid DECIMAL(15, 2),
    reason VARCHAR(255),
    rule_id INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (campaign_id) REFERENCES campaigns(campaign_id) ON DELETE CASCADE,
    INDEX idx_campaign (campaign_id),
    INDEX idx_created (created_at)
);

-- Пользователи (авторизация через Telegram)
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    telegram_id BIGINT UNIQUE NOT NULL,
    username VARCHAR(64),
    first_name VARCHAR(128),
    last_name VARCHAR(128),
    photo_url TEXT,
    role VARCHAR(20) NOT NULL DEFAULT 'user',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_telegram_id (telegram_id),
    INDEX idx_role (role)
);

-- Заказы (лента заказов)
CREATE TABLE IF NOT EXISTS orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    order_id BIGINT UNIQUE NOT NULL,
    nm_id BIGINT NOT NULL,
    srid VARCHAR(128),
    date_created DATETIME NOT NULL,
    date_updated DATETIME,
    warehouse_name VARCHAR(255),
    region VARCHAR(255),
    price DECIMAL(15, 2) DEFAULT 0,
    converted_price DECIMAL(15, 2) DEFAULT 0,
    discount_percent INT DEFAULT 0,
    spp DECIMAL(10, 2) DEFAULT 0,
    finished_price DECIMAL(15, 2) DEFAULT 0,
    price_with_disc DECIMAL(15, 2) DEFAULT 0,
    size VARCHAR(50),
    brand VARCHAR(255),
    subject VARCHAR(255),
    category VARCHAR(255),
    status VARCHAR(50) DEFAULT 'new',
    cancel_dt DATETIME,
    is_cancel BOOLEAN DEFAULT FALSE,
    sticker VARCHAR(128),
    gn_number VARCHAR(128),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_nm_id (nm_id),
    INDEX idx_order_id (order_id),
    INDEX idx_date_created (date_created),
    INDEX idx_status (status)
);

-- Остатки (снапшоты по складам)
CREATE TABLE IF NOT EXISTS stock_snapshots (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nm_id BIGINT NOT NULL,
    last_change_date DATETIME,
    supplier_article VARCHAR(128),
    tech_size VARCHAR(50),
    barcode VARCHAR(128),
    quantity INT DEFAULT 0,
    in_way_to_client INT DEFAULT 0,
    in_way_from_client INT DEFAULT 0,
    quantity_full INT DEFAULT 0,
    warehouse_name VARCHAR(255),
    category VARCHAR(255),
    subject VARCHAR(255),
    brand VARCHAR(255),
    sc_code VARCHAR(128),
    price DECIMAL(15, 2) DEFAULT 0,
    discount DECIMAL(10, 2) DEFAULT 0,
    snapshot_date DATE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_stock_snapshot (nm_id, tech_size, warehouse_name, snapshot_date),
    INDEX idx_nm_id (nm_id),
    INDEX idx_snapshot_date (snapshot_date),
    INDEX idx_warehouse (warehouse_name)
);

-- Аналитика по источникам трафика
CREATE TABLE IF NOT EXISTS traffic_source_analytics (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nm_id BIGINT NOT NULL,
    date DATE NOT NULL,
    source_name VARCHAR(100) NOT NULL,
    open_card_count INT DEFAULT 0,
    add_to_cart_count INT DEFAULT 0,
    orders_count INT DEFAULT 0,
    orders_sum DECIMAL(15, 2) DEFAULT 0,
    buyouts_count INT DEFAULT 0,
    buyouts_sum DECIMAL(15, 2) DEFAULT 0,
    cancel_count INT DEFAULT 0,
    cancel_sum DECIMAL(15, 2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_traffic_source (nm_id, date, source_name),
    INDEX idx_nm_id (nm_id),
    INDEX idx_date (date),
    INDEX idx_source (source_name)
);

-- Маркетинговая активность (журнал событий)
CREATE TABLE IF NOT EXISTS marketing_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    nm_id BIGINT NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    description TEXT,
    event_date DATE NOT NULL,
    created_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_nm_id (nm_id),
    INDEX idx_event_date (event_date),
    INDEX idx_event_type (event_type)
);

-- Таблица агрегированной статистики по дням
CREATE VIEW daily_summary AS
SELECT
    cs.date,
    COUNT(DISTINCT cs.campaign_id) as campaigns_count,
    SUM(cs.views) as total_views,
    SUM(cs.clicks) as total_clicks,
    ROUND(SUM(cs.clicks) / NULLIF(SUM(cs.views), 0) * 100, 2) as avg_ctr,
    SUM(cs.spend) as total_spend,
    SUM(cs.orders) as total_orders,
    SUM(cs.order_sum) as total_order_sum,
    ROUND(SUM(cs.order_sum) / NULLIF(SUM(cs.spend), 0), 2) as roas
FROM campaign_stats cs
GROUP BY cs.date
ORDER BY cs.date DESC;

-- P&L сводка по товарам
CREATE VIEW pnl_summary AS
SELECT
    p.nm_id,
    p.name,
    p.brand,
    COALESCE(SUM(sr.revenue), 0) as total_revenue,
    COALESCE(SUM(sr.wb_commission), 0) as total_wb_commission,
    COALESCE(SUM(sr.logistics_cost), 0) as total_logistics,
    COALESCE(SUM(sr.storage_cost), 0) as total_storage,
    COALESCE(SUM(sr.penalties), 0) as total_penalties,
    COALESCE(SUM(sr.net_payment), 0) as total_net_payment,
    COALESCE(pc.cost_price, 0) as cost_price,
    COALESCE(SUM(sr.quantity), 0) as total_quantity,
    COALESCE(SUM(sr.returns_count), 0) as total_returns,
    COALESCE(SUM(sr.net_payment), 0) - COALESCE(pc.cost_price, 0) * COALESCE(SUM(sr.quantity), 0) as estimated_profit
FROM products p
LEFT JOIN sales_reports sr ON p.nm_id = sr.nm_id
LEFT JOIN product_costs pc ON p.nm_id = pc.nm_id
GROUP BY p.nm_id, p.name, p.brand, pc.cost_price;
