#!/bin/sh
# First start of the PostgreSQL container only (docker-entrypoint-initdb.d).
# Creates: the schema-owner role (runs migrations), the application role (NO BYPASSRLS, so Row Level
# Security always applies) and the application database. Passwords come from the environment.
set -e
: "${SSCRM_OWNER_PASSWORD:?SSCRM_OWNER_PASSWORD is required}"
: "${SSCRM_APP_PASSWORD:?SSCRM_APP_PASSWORD is required}"
DB="${SSCRM_DB_NAME:-sscrm}"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE sscrm_owner LOGIN PASSWORD '${SSCRM_OWNER_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE ROLE sscrm_app LOGIN PASSWORD '${SSCRM_APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE DATABASE "${DB}" OWNER sscrm_owner;
REVOKE ALL ON DATABASE "${DB}" FROM PUBLIC;
GRANT CONNECT ON DATABASE "${DB}" TO sscrm_app;
SQL
