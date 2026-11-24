-- HYPEMAX SSO (OpenID Connect provider). Only hashes of codes and tokens are stored.

CREATE TABLE sso_keys (
  kid VARCHAR(40) PRIMARY KEY,
  private_pem TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

CREATE TABLE sso_codes (
  code_hash CHAR(64) PRIMARY KEY,
  client_id VARCHAR(100) NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  session_hash CHAR(64) NOT NULL,
  redirect_uri VARCHAR(500) NOT NULL,
  code_challenge VARCHAR(128) NOT NULL,
  nonce VARCHAR(255) NULL,
  scope VARCHAR(255) NOT NULL,
  auth_time DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  used_at DATETIME NULL,
  family_id CHAR(32) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE sso_refresh_tokens (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  token_hash CHAR(64) NOT NULL UNIQUE,
  family_id CHAR(32) NOT NULL,
  client_id VARCHAR(100) NOT NULL,
  user_id INT UNSIGNED NOT NULL,
  session_hash CHAR(64) NOT NULL,
  scope VARCHAR(255) NOT NULL,
  auth_time DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  rotated_at DATETIME NULL,
  revoked_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_sso_rt_family (family_id),
  INDEX idx_sso_rt_session (session_hash),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;
