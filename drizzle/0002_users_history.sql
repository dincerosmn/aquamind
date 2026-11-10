ALTER TABLE audit_log ADD COLUMN entity_type TEXT NOT NULL DEFAULT 'system';
--> statement-breakpoint
ALTER TABLE audit_log ADD COLUMN entity_id TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE audit_log ADD COLUMN details TEXT NOT NULL DEFAULT '';
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS app_roles (
  role_key TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT ''
);
--> statement-breakpoint

INSERT OR IGNORE INTO app_roles (role_key, label, permissions_json, updated_at) VALUES
('admin', 'Sistem yöneticisi', '["view","edit_services","edit_customers","edit_equipment","edit_products","manage_design","manage_users","view_history","manage_backups"]', ''),
('service_manager', 'Servis yöneticisi', '["view","edit_services","edit_customers","edit_equipment","edit_products"]', ''),
('technician', 'Teknisyen', '["view","edit_services"]', ''),
('viewer', 'Görüntüleyici', '["view"]', '');
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log(created_at DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS audit_log_entity_idx ON audit_log(entity_type, entity_id, created_at DESC);
--> statement-breakpoint
INSERT OR IGNORE INTO app_users (email, account_id, display_name, role, active, created_at, updated_at) VALUES
('sales@aquamind.com.tr', NULL, 'Satış', 'viewer', 1, datetime('now'), datetime('now')),
('service@aquamind.com.tr', NULL, 'Servis', 'technician', 1, datetime('now'), datetime('now')),
('info@aquamind.com.tr', NULL, 'Bilgi', 'viewer', 1, datetime('now'), datetime('now'));
--> statement-breakpoint
INSERT OR IGNORE INTO app_users (email, account_id, display_name, role, active, created_at, updated_at) VALUES
('dincer.osmn@gmail.com', NULL, 'Osman Dinçer', 'admin', 1, datetime('now'), datetime('now'));
--> statement-breakpoint
INSERT INTO audit_log (account_id, email, action, revision, created_at, entity_type, entity_id, details) VALUES
('system', 'system@aquamind.com.tr', 'created', 0, datetime('now'), 'user', 'sales@aquamind.com.tr', 'Ön tanımlı rol: Görüntüleyici'),
('system', 'system@aquamind.com.tr', 'created', 0, datetime('now'), 'user', 'service@aquamind.com.tr', 'Ön tanımlı rol: Teknisyen'),
('system', 'system@aquamind.com.tr', 'created', 0, datetime('now'), 'user', 'info@aquamind.com.tr', 'Ön tanımlı rol: Görüntüleyici'),
('system', 'system@aquamind.com.tr', 'created', 0, datetime('now'), 'user', 'dincer.osmn@gmail.com', 'İlk sistem yöneticisi hesabı');
--> statement-breakpoint
