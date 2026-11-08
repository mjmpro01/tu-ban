#!/bin/bash
# Runs once, when the Postgres volume is first created: databases for Mem0
# (vectors in "mem0", its own users/API keys in "mem0_app").
set -e
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
    SELECT 'CREATE DATABASE mem0' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'mem0')\gexec
    SELECT 'CREATE DATABASE mem0_app' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'mem0_app')\gexec
EOSQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname mem0 -c "CREATE EXTENSION IF NOT EXISTS vector"
