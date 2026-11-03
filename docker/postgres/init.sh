#!/bin/sh
# Creates the schema-owner role, the application role (no BYPASSRLS) and the dev/test databases.
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<SQL
CREATE ROLE sscrm_owner LOGIN PASSWORD '${SSCRM_OWNER_PASSWORD}';
CREATE ROLE sscrm_app LOGIN PASSWORD '${SSCRM_APP_PASSWORD}' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
CREATE DATABASE sscrm OWNER sscrm_owner;
CREATE DATABASE sscrm_test OWNER sscrm_owner;
SQL
