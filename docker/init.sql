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
