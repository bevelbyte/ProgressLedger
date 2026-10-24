-- 002_attachments.sql— relative attachment storage (schema version 2).
-- PDFs are copied into <userData>/attachments/<profile_id>/<resource_id>.pdf and
-- referenced by a RELATIVE path so moving/deleting the user's original file never
-- breaks the link. `file_path` is kept for backward-compat; `rel_path` is the new
-- canonical internal location, resolved to an absolute path by the Rust layer.

ALTER TABLE resources ADD COLUMN rel_path  TEXT;     -- e.g. "3/57.pdf" under the attachments root
ALTER TABLE resources ADD COLUMN orig_path TEXT;     -- where the user imported it from (informational)
ALTER TABLE resources ADD COLUMN byte_size INTEGER;  -- copied-file size in bytes (integrity / UX)

-- Preserve provenance for any pre-existing absolute paths.
UPDATE resources
   SET orig_path = file_path
 WHERE kind = 'pdf' AND orig_path IS NULL AND file_path IS NOT NULL;