-- Phase 1 BLF / Live Extension Availability (UponAI)
-- Safe to re-run: uses IF NOT EXISTS

CREATE TABLE IF NOT EXISTS blf_configurations
(
  blf_configuration_sid CHAR(36) NOT NULL UNIQUE,
  account_sid CHAR(36) NOT NULL,
  voip_carrier_sid CHAR(36) NOT NULL,
  is_enabled BOOLEAN NOT NULL DEFAULT false,
  event_package ENUM('dialog','presence') NOT NULL DEFAULT 'dialog',
  subscribe_expires INTEGER NOT NULL DEFAULT 3600,
  stale_seconds INTEGER NOT NULL DEFAULT 120
    COMMENT 'mark unknown if no fresh NOTIFY within this window',
  availability_hook_sid CHAR(36)
    COMMENT 'optional webhook; falls back to none if null',
  capability_token_hash CHAR(64)
    COMMENT 'sha256 of opaque public poll token',
  capability_token_encrypted VARCHAR(1024)
    COMMENT 'so tenant admin can copy current URL; rotate replaces both',
  owner_node VARCHAR(64)
    COMMENT 'sidecar instance id currently owning subscriptions',
  last_reconcile_at DATETIME,
  last_error VARCHAR(512),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (blf_configuration_sid),
  UNIQUE KEY blf_config_carrier_idx (voip_carrier_sid),
  KEY blf_config_account_idx (account_sid)
);

CREATE TABLE IF NOT EXISTS blf_monitors
(
  blf_monitor_sid CHAR(36) NOT NULL UNIQUE,
  blf_configuration_sid CHAR(36) NOT NULL,
  extension VARCHAR(64) NOT NULL,
  display_name VARCHAR(128),
  presentity_uri VARCHAR(255) NOT NULL
    COMMENT 'e.g. sip:101@pbx.example.com',
  is_enabled BOOLEAN NOT NULL DEFAULT true,
  contact_user VARCHAR(64) NOT NULL
    COMMENT 'blf-<uuid> used in Contact; unique cluster-wide',
  sub_call_id VARCHAR(255),
  sub_local_tag VARCHAR(128),
  sub_remote_tag VARCHAR(128),
  sub_remote_target VARCHAR(512),
  sub_route_set TEXT,
  sub_cseq INTEGER,
  sub_expires_at DATETIME,
  sub_status ENUM('none','trying','active','pending','terminated','error')
    NOT NULL DEFAULT 'none',
  owner_node VARCHAR(64),
  state ENUM('unknown','idle','ringing','busy','held','unavailable')
    NOT NULL DEFAULT 'unknown',
  subscription_state VARCHAR(32)
    COMMENT 'active|pending|terminated from NOTIFY Subscription-State',
  state_raw VARCHAR(64)
    COMMENT 'provider-specific token kept for debug',
  last_notify_at DATETIME,
  stale_at DATETIME,
  last_error VARCHAR(512),
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (blf_monitor_sid),
  UNIQUE KEY blf_monitor_contact_idx (contact_user),
  UNIQUE KEY blf_monitor_presentity_idx (blf_configuration_sid, presentity_uri),
  KEY blf_monitor_config_idx (blf_configuration_sid)
);

CREATE TABLE IF NOT EXISTS blf_notify_events
(
  blf_notify_event_sid CHAR(36) NOT NULL UNIQUE,
  blf_monitor_sid CHAR(36) NOT NULL,
  event_digest CHAR(64) NOT NULL
    COMMENT 'sha256 of call-id|cseq|body for dedupe',
  source_ip VARCHAR(64),
  event_package VARCHAR(32),
  subscription_state VARCHAR(32),
  parsed_state ENUM('unknown','idle','ringing','busy','held','unavailable'),
  body_bytes INTEGER,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (blf_notify_event_sid),
  UNIQUE KEY blf_notify_digest_idx (blf_monitor_sid, event_digest),
  KEY blf_notify_monitor_created_idx (blf_monitor_sid, created_at)
);

-- Foreign keys (ignore if already present)
SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'blf_configurations'
    AND CONSTRAINT_NAME = 'blf_configurations_account_sid_fk'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE blf_configurations ADD CONSTRAINT blf_configurations_account_sid_fk FOREIGN KEY (account_sid) REFERENCES accounts (account_sid) ON DELETE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'blf_configurations'
    AND CONSTRAINT_NAME = 'blf_configurations_voip_carrier_sid_fk'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE blf_configurations ADD CONSTRAINT blf_configurations_voip_carrier_sid_fk FOREIGN KEY (voip_carrier_sid) REFERENCES voip_carriers (voip_carrier_sid) ON DELETE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'blf_configurations'
    AND CONSTRAINT_NAME = 'blf_configurations_availability_hook_sid_fk'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE blf_configurations ADD CONSTRAINT blf_configurations_availability_hook_sid_fk FOREIGN KEY (availability_hook_sid) REFERENCES webhooks (webhook_sid) ON DELETE SET NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'blf_monitors'
    AND CONSTRAINT_NAME = 'blf_monitors_configuration_sid_fk'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE blf_monitors ADD CONSTRAINT blf_monitors_configuration_sid_fk FOREIGN KEY (blf_configuration_sid) REFERENCES blf_configurations (blf_configuration_sid) ON DELETE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk_exists := (
  SELECT COUNT(*) FROM information_schema.TABLE_CONSTRAINTS
  WHERE CONSTRAINT_SCHEMA = DATABASE()
    AND TABLE_NAME = 'blf_notify_events'
    AND CONSTRAINT_NAME = 'blf_notify_events_monitor_sid_fk'
);
SET @sql := IF(@fk_exists = 0,
  'ALTER TABLE blf_notify_events ADD CONSTRAINT blf_notify_events_monitor_sid_fk FOREIGN KEY (blf_monitor_sid) REFERENCES blf_monitors (blf_monitor_sid) ON DELETE CASCADE',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
