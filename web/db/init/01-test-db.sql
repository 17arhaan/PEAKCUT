-- Create test database if it doesn't already exist
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = 'shorts_factory_test' AND pid <> pg_backend_pid();

CREATE DATABASE shorts_factory_test;
