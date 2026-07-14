-- Create test database if it doesn't already exist
SELECT pg_terminate_backend(pid)
FROM pg_stat_activity
WHERE datname = 'peakcut_test' AND pid <> pg_backend_pid();

CREATE DATABASE peakcut_test;
