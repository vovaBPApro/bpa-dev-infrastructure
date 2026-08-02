#!/usr/bin/env bash
# Canonical secret signature shared by landing and runtime masking.

land_secret_scan() {
  local secret_pattern
  secret_pattern=$(printf '%s%s%s%s%s%s%s%s%s%s%s' '[0-9]{8,10}:AA|' 'gh' 'p_|github' '_pat|client' '_secret|PRIVATE ' 'KEY|AK' 'IA[0-9A-Z]{16}|' 'sk' '-ant-|' '(^|[^0-9A-Za-z_-])AIza[0-9A-Za-z_-]{35}([^0-9A-Za-z_-]|$)|' '(^|[^0-9A-Za-z])xox[baprs]-[0-9A-Za-z-]{10,}([^0-9A-Za-z]|$)')
}
