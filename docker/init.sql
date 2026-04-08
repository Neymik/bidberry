-- WB Analytics Database Schema

-- =============================================
-- Multi-Cabinet Architecture: Core Tables
-- =============================================

-- Аккаунты (команда / организация)
CREATE TABLE IF NOT EXISTS accounts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
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

-- Связь пользователей и аккаунтов (M:N)
CREATE TABLE IF NOT EXISTS user_accounts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    account_id INT NOT NULL,
    role VARCHAR(20) NOT NULL DEFAULT 'member',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    UNIQUE KEY unique_user_account (user_id, account_id),
    INDEX idx_user_id (user_id),
    INDEX idx_account_id (account_id)
);

-- Кабинеты (WB API токен + scope данных)
CREATE TABLE IF NOT EXISTS cabinets (
    id INT AUTO_INCREMENT PRIMARY KEY,
    account_id INT NOT NULL,
    name VARCHAR(255) NOT NULL,
    wb_api_key TEXT NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    last_sync_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE,
    INDEX idx_account_id (account_id),
    INDEX idx_active (is_active)
);

-- Белый список пользователей (по telegram_id, username — legacy/seed)
--
-- Dual-mode: rows with telegram_id IS NULL are "pending claim" — the first
-- successful login by a user whose Telegram username matches will lock the
-- row to that user's telegram_id. Once locked, the username field is just
-- a label; access is keyed on telegram_id.
CREATE TABLE IF NOT EXISTS allowed_users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(64) NOT NULL,
    telegram_id BIGINT NULL,
    added_by VARCHAR(64),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_username (username),
    UNIQUE KEY uq_allowed_users_telegram_id (telegram_id)
);

-- Seed allowed_users with existing whitelist
INSERT IGNORE INTO allowed_users (username, added_by) VALUES
    ('tNeymik', 'system'),
    ('Ropejamp', 'system'),
    ('Valentina_09876', 'system'),
    ('pauluzumuz', 'system');

-- =============================================
-- Data Tables (all scoped by cabinet_id)
-- =============================================

-- Таблица рекламных кампаний
CREATE TABLE IF NOT EXISTS campaigns (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cabinet_id INT,
    campaign_id BIGINT NOT NULL,
    name VARCHAR(255),
    type VARCHAR(50),
    status VARCHAR(50),
    start_date DATETIME,
    end_date DATETIME,
    daily_budget DECIMAL(15, 2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_cabinet_campaign (cabinet_id, campaign_id),
    INDEX idx_campaign_id (campaign_id),
    INDEX idx_status (status),
    INDEX idx_cabinet_id (cabinet_id)
);

-- Таблица ставок (bidding)
CREATE TABLE IF NOT EXISTS bids (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cabinet_id INT,
    campaign_id BIGINT NOT NULL,
    keyword VARCHAR(500),
    bid DECIMAL(15, 2),
    position INT,
    cpm DECIMAL(15, 2),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_campaign (campaign_id),
    INDEX idx_keyword (keyword(255)),
    INDEX idx_cabinet_id (cabinet_id)
);

-- Таблица статистики кампаний
CREATE TABLE IF NOT EXISTS campaign_stats (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cabinet_id INT,
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
    UNIQUE KEY unique_cabinet_campaign_date (cabinet_id, campaign_id, date),
    INDEX idx_date (date),
    INDEX idx_cabinet_id (cabinet_id)
);

-- Таблица товаров
CREATE TABLE IF NOT EXISTS products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cabinet_id INT,
    nm_id BIGINT NOT NULL,
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
    UNIQUE KEY unique_cabinet_nm (cabinet_id, nm_id),
    INDEX idx_nm_id (nm_id),
    INDEX idx_brand (brand),
    INDEX idx_subject (subject),
    INDEX idx_cabinet_id (cabinet_id)
);

-- Таблица аналитики по товарам
CREATE TABLE IF NOT EXISTS product_analytics (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cabinet_id INT,
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
    UNIQUE KEY unique_cabinet_product_date (cabinet_id, nm_id, date),
    INDEX idx_date (date),
    INDEX idx_cabinet_id (cabinet_id)
);

-- Таблица ключевых слов и позиций
CREATE TABLE IF NOT EXISTS keyword_positions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cabinet_id INT,
    nm_id BIGINT NOT NULL,
    keyword VARCHAR(500) NOT NULL,
    position INT,
    page INT,
    frequency INT,
    checked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_keyword (keyword(255)),
    INDEX idx_nm_id (nm_id),
    INDEX idx_checked_at (checked_at),
    INDEX idx_cabinet_id (cabinet_id)
);

-- Таблица истории импортов
CREATE TABLE IF NOT EXISTS import_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cabinet_id INT,
    import_type VARCHAR(50) NOT NULL,
    file_name VARCHAR(255),
    records_count INT DEFAULT 0,
    status VARCHAR(50) DEFAULT 'pending',
    error_message TEXT,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,
    INDEX idx_cabinet_id (cabinet_id)
);

-- Коллекции ключевых слов для отслеживания
CREATE TABLE IF NOT EXISTS keyword_collections (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cabinet_id INT,
    nm_id BIGINT NOT NULL,
    keyword VARCHAR(500) NOT NULL,
    frequency INT DEFAULT 0,
    is_tracked BOOLEAN DEFAULT TRUE,
    source VARCHAR(50) DEFAULT 'manual',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_cabinet_product_keyword (cabinet_id, nm_id, keyword(255)),
    INDEX idx_nm_id (nm_id),
    INDEX idx_tracked (is_tracked),
    INDEX idx_cabinet_id (cabinet_id)
);

-- Себестоимость и расходы по товарам
CREATE TABLE IF NOT EXISTS product_costs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cabinet_id INT,
    nm_id BIGINT NOT NULL,
    cost_price DECIMAL(15, 2) DEFAULT 0,
    logistics_cost DECIMAL(15, 2) DEFAULT 0,
    commission_pct DECIMAL(5, 2) DEFAULT 0,
    storage_cost DECIMAL(15, 2) DEFAULT 0,
    packaging_cost DECIMAL(15, 2) DEFAULT 0,
    additional_cost DECIMAL(15, 2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_cabinet_product_cost (cabinet_id, nm_id),
    INDEX idx_cabinet_id (cabinet_id)
);

-- Отчёты по продажам от WB
CREATE TABLE IF NOT EXISTS sales_reports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cabinet_id INT,
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
    UNIQUE KEY unique_cabinet_sales_date (cabinet_id, nm_id, date),
    INDEX idx_date (date),
    INDEX idx_cabinet_id (cabinet_id)
);

-- Правила автоставок (Smart Bidder)
CREATE TABLE IF NOT EXISTS bid_rules (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cabinet_id INT,
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
    INDEX idx_campaign (campaign_id),
    INDEX idx_active (is_active),
    INDEX idx_cabinet_id (cabinet_id)
);

-- Журнал изменений ставок
CREATE TABLE IF NOT EXISTS bid_history (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cabinet_id INT,
    campaign_id BIGINT NOT NULL,
    keyword VARCHAR(500),
    old_bid DECIMAL(15, 2),
    new_bid DECIMAL(15, 2),
    reason VARCHAR(255),
    rule_id INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_campaign (campaign_id),
    INDEX idx_created (created_at),
    INDEX idx_cabinet_id (cabinet_id)
);

-- Заказы (лента заказов)
CREATE TABLE IF NOT EXISTS orders (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cabinet_id INT,
    order_id BIGINT NOT NULL,
    nm_id BIGINT NOT NULL,
    srid VARCHAR(128) NOT NULL,
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
    UNIQUE KEY unique_cabinet_srid (cabinet_id, srid),
    INDEX idx_nm_id (nm_id),
    INDEX idx_order_id (order_id),
    INDEX idx_date_created (date_created),
    INDEX idx_status (status),
    INDEX idx_cabinet_id (cabinet_id)
);

-- Остатки (снапшоты по складам)
CREATE TABLE IF NOT EXISTS stock_snapshots (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cabinet_id INT,
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
    UNIQUE KEY unique_cabinet_stock_snapshot (cabinet_id, nm_id, tech_size, warehouse_name, snapshot_date),
    INDEX idx_nm_id (nm_id),
    INDEX idx_snapshot_date (snapshot_date),
    INDEX idx_warehouse (warehouse_name),
    INDEX idx_cabinet_id (cabinet_id)
);

-- Аналитика по источникам трафика
CREATE TABLE IF NOT EXISTS traffic_source_analytics (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cabinet_id INT,
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
    UNIQUE KEY unique_cabinet_traffic_source (cabinet_id, nm_id, date, source_name),
    INDEX idx_nm_id (nm_id),
    INDEX idx_date (date),
    INDEX idx_source (source_name),
    INDEX idx_cabinet_id (cabinet_id)
);

-- Маркетинговая активность (журнал событий)
CREATE TABLE IF NOT EXISTS marketing_events (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cabinet_id INT,
    nm_id BIGINT NOT NULL,
    event_type VARCHAR(50) NOT NULL,
    description TEXT,
    event_date DATE NOT NULL,
    created_by INT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_nm_id (nm_id),
    INDEX idx_event_date (event_date),
    INDEX idx_event_type (event_type),
    INDEX idx_cabinet_id (cabinet_id)
);

-- Участие в акциях
CREATE TABLE IF NOT EXISTS promotion_participation (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cabinet_id INT,
    nm_id BIGINT NOT NULL,
    promo_id BIGINT NOT NULL,
    promo_name VARCHAR(500),
    promo_type VARCHAR(100),
    start_date DATETIME,
    end_date DATETIME,
    is_participating BOOLEAN DEFAULT FALSE,
    synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_cabinet_nm_promo (cabinet_id, nm_id, promo_id),
    INDEX idx_nm_id (nm_id),
    INDEX idx_promo_id (promo_id),
    INDEX idx_cabinet_id (cabinet_id)
);

-- Связь кампаний и товаров
CREATE TABLE IF NOT EXISTS campaign_products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cabinet_id INT,
    campaign_id BIGINT NOT NULL,
    nm_id BIGINT NOT NULL,
    synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY unique_cabinet_campaign_nm (cabinet_id, campaign_id, nm_id),
    INDEX idx_campaign_id (campaign_id),
    INDEX idx_nm_id (nm_id),
    INDEX idx_cabinet_id (cabinet_id)
);

-- Аналитика поисковых запросов (из Seller Analytics SEARCH_REPORT)
CREATE TABLE IF NOT EXISTS search_query_analytics (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cabinet_id INT,
    nm_id BIGINT NOT NULL,
    keyword VARCHAR(500) NOT NULL,
    date DATE NOT NULL,
    avg_position DECIMAL(8,2) DEFAULT 0,
    impressions INT DEFAULT 0,
    ctr DECIMAL(10,4) DEFAULT 0,
    card_visits INT DEFAULT 0,
    cart_adds INT DEFAULT 0,
    cart_conversion DECIMAL(10,4) DEFAULT 0,
    orders_count INT DEFAULT 0,
    order_conversion DECIMAL(10,4) DEFAULT 0,
    visibility DECIMAL(10,4) DEFAULT 0,
    current_price DECIMAL(15,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_cabinet_nm_kw_date (cabinet_id, nm_id, keyword(255), date),
    INDEX idx_nm_id (nm_id),
    INDEX idx_keyword (keyword(255)),
    INDEX idx_date (date),
    INDEX idx_cabinet_id (cabinet_id)
);

-- Статистика поисковых кластеров рекламных кампаний
CREATE TABLE IF NOT EXISTS search_cluster_stats (
    id INT AUTO_INCREMENT PRIMARY KEY,
    cabinet_id INT,
    campaign_id BIGINT NOT NULL,
    cluster_name VARCHAR(500) NOT NULL,
    date DATE NOT NULL,
    views INT DEFAULT 0,
    clicks INT DEFAULT 0,
    ctr DECIMAL(10,4) DEFAULT 0,
    cpc DECIMAL(15,2) DEFAULT 0,
    cpm DECIMAL(15,2) DEFAULT 0,
    cart_adds INT DEFAULT 0,
    orders_count INT DEFAULT 0,
    spend DECIMAL(15,2) DEFAULT 0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY unique_cabinet_campaign_cluster_date (cabinet_id, campaign_id, cluster_name(255), date),
    INDEX idx_campaign_id (campaign_id),
    INDEX idx_date (date),
    INDEX idx_cabinet_id (cabinet_id)
);

-- Campaign expense history (from /adv/v1/upd)
CREATE TABLE IF NOT EXISTS campaign_expenses (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cabinet_id INT NOT NULL,
  advert_id BIGINT NOT NULL,
  upd_num BIGINT NOT NULL,
  upd_time DATETIME NOT NULL,
  upd_sum DECIMAL(12,2) NOT NULL DEFAULT 0,
  campaign_name VARCHAR(255) DEFAULT '',
  advert_type INT DEFAULT 0,
  payment_type VARCHAR(50) DEFAULT '',
  advert_status INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_expense (cabinet_id, advert_id, upd_time),
  INDEX idx_advert_time (cabinet_id, advert_id, upd_time),
  INDEX idx_time (cabinet_id, upd_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Account top-up history (from /adv/v1/payments)
CREATE TABLE IF NOT EXISTS account_payments (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cabinet_id INT NOT NULL,
  payment_id BIGINT NOT NULL,
  payment_date DATETIME NOT NULL,
  sum DECIMAL(12,2) NOT NULL DEFAULT 0,
  type INT DEFAULT 0,
  status_id INT DEFAULT 0,
  card_status VARCHAR(50) DEFAULT '',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_payment (cabinet_id, payment_id),
  INDEX idx_date (cabinet_id, payment_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Per-product CPS settings (user-defined)
CREATE TABLE IF NOT EXISTS product_cps_settings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cabinet_id INT NOT NULL,
  nm_id BIGINT NOT NULL,
  buyout_pct DECIMAL(5,2) NOT NULL DEFAULT 80.00,
  planned_budget_daily INT DEFAULT NULL,
  order_scale_pct DECIMAL(5,2) DEFAULT NULL,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_product_settings (cabinet_id, nm_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Campaign budget snapshots (polled every 15 min for hourly spend calculation)
CREATE TABLE IF NOT EXISTS campaign_budget_snapshots (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cabinet_id INT NOT NULL,
  campaign_id BIGINT NOT NULL,
  budget DECIMAL(12,2) NOT NULL DEFAULT 0,
  daily_budget DECIMAL(12,2) NOT NULL DEFAULT 0,
  snapshot_at DATETIME NOT NULL,
  spend_since_prev DECIMAL(12,2) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_campaign_time (cabinet_id, campaign_id, snapshot_at),
  INDEX idx_time (cabinet_id, snapshot_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Emulator instance management (multi-tenant Android emulators)
CREATE TABLE IF NOT EXISTS emulator_instances (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cabinet_id INT NOT NULL UNIQUE,
  emu_container_id VARCHAR(64),
  scrcpy_container_id VARCHAR(64),
  monitor_container_id VARCHAR(64),
  emu_container_name VARCHAR(100) NOT NULL,
  scrcpy_container_name VARCHAR(100) NOT NULL,
  monitor_container_name VARCHAR(100) NOT NULL,
  status ENUM('created','running','stopped','error') DEFAULT 'created',
  monitor_status ENUM('stopped','running','error') DEFAULT 'stopped',
  adb_port INT NOT NULL,
  scrcpy_port INT NOT NULL,
  ingest_api_key VARCHAR(64) NOT NULL,
  last_heartbeat TIMESTAMP NULL,
  error_message TEXT,
  created_by INT NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (cabinet_id) REFERENCES cabinets(id),
  FOREIGN KEY (created_by) REFERENCES users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Orders scraped from emulator (different schema from WB API orders table)
CREATE TABLE IF NOT EXISTS emu_orders (
  id INT AUTO_INCREMENT PRIMARY KEY,
  cabinet_id INT NOT NULL,
  dedup_key VARCHAR(255) NOT NULL,
  article VARCHAR(50) NOT NULL,
  product VARCHAR(500),
  size VARCHAR(50),
  quantity VARCHAR(20),
  status VARCHAR(50),
  price VARCHAR(50),
  price_cents INT,
  date_raw VARCHAR(100),
  date_parsed DATETIME,
  category VARCHAR(200),
  warehouse VARCHAR(200),
  arrival_city VARCHAR(200),
  first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_dedup (cabinet_id, dedup_key),
  INDEX idx_cabinet (cabinet_id),
  INDEX idx_article (cabinet_id, article),
  INDEX idx_status (cabinet_id, status),
  INDEX idx_first_seen (cabinet_id, first_seen),
  FOREIGN KEY (cabinet_id) REFERENCES cabinets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
