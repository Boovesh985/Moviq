-- Continuous learning: sentence-level spoiler labels, sentiment, model registry, real-data provenance.
-- Idempotent: safe to run on an existing database.

ALTER TABLE users   ADD COLUMN IF NOT EXISTS source   TEXT DEFAULT 'moviq';   -- moviq | movielens | synthetic
ALTER TABLE users   ADD COLUMN IF NOT EXISTS is_admin BOOLEAN DEFAULT FALSE;
ALTER TABLE movies  ADD COLUMN IF NOT EXISTS movielens_id INT UNIQUE;
ALTER TABLE movies  ADD COLUMN IF NOT EXISTS imdb_id TEXT;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS sentiment REAL;              -- P(positive) of the review text
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS aspects   JSONB DEFAULT '[]'; -- [{aspect, score, start, end}]
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS scored_by JSONB DEFAULT '{}'; -- model versions that scored this review

-- Readers and authors label individual sentences; these are the Spoiler Shield's live training data.
CREATE TABLE IF NOT EXISTS spoiler_labels (
  id         SERIAL PRIMARY KEY,
  review_id  INT REFERENCES reviews(id) ON DELETE CASCADE,
  user_id    INT REFERENCES users(id) ON DELETE CASCADE,
  sentence   TEXT NOT NULL,            -- stored so edits to the review don't corrupt the label
  label      SMALLINT NOT NULL CHECK (label IN (0, 1)),
  source     TEXT NOT NULL CHECK (source IN ('reader', 'author', 'flag')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (review_id, user_id, sentence)
);
CREATE INDEX IF NOT EXISTS spoiler_labels_created_idx ON spoiler_labels (created_at);

-- Every training run, deployed or not, with its evaluation metrics.
CREATE TABLE IF NOT EXISTS model_versions (
  id          SERIAL PRIMARY KEY,
  model       TEXT NOT NULL,           -- spoiler | sentiment | recommender
  version     INT NOT NULL,
  metrics     JSONB NOT NULL,
  baseline    JSONB DEFAULT '{}',      -- metrics of the model it was compared against
  n_train     INT,
  n_live      INT,                     -- examples that came from Moviq's own database
  deployed    BOOLEAN NOT NULL,
  reason      TEXT,
  trained_at  TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (model, version)
);

UPDATE users SET is_admin = TRUE WHERE username = 'demo';
UPDATE users SET source = 'synthetic' WHERE is_demo AND source = 'moviq';
