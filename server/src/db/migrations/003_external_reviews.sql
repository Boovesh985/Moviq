-- Reviews imported from outside Moviq (TMDB, a member's Letterboxd export) keep their origin.
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS source_url  TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS external_id TEXT UNIQUE;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS sentiment_model REAL;  -- the model's own reading, before the star rating is taken into account
