-- Migration 007: Add code column to subjects table.
ALTER TABLE subjects ADD COLUMN code TEXT;
