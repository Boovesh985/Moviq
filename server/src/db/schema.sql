-- Moviq schema. Safe to re-run: drops and recreates everything.
DROP TABLE IF EXISTS model_versions, spoiler_labels, room_votes, room_members, watch_rooms, spoiler_reports, review_likes,
  reviews, watch_history, watchlist, follows, movies, users CASCADE;

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  username      TEXT UNIQUE NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  bio           TEXT DEFAULT '',
  avatar_hue    INT  DEFAULT 200,
  services      TEXT[] DEFAULT '{}',      -- streaming services the user pays for
  favorite_ids  INT[]  DEFAULT '{}',      -- Letterboxd-style "four favorites"
  is_demo       BOOLEAN DEFAULT FALSE,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE movies (
  id            SERIAL PRIMARY KEY,
  tmdb_id       INT UNIQUE,
  title         TEXT NOT NULL,
  year          INT,
  runtime       INT,
  overview      TEXT DEFAULT '',
  tagline       TEXT DEFAULT '',
  genres        TEXT[] DEFAULT '{}',
  moods         TEXT[] DEFAULT '{}',
  director      TEXT DEFAULT '',
  cast_names    TEXT[] DEFAULT '{}',
  certification TEXT DEFAULT 'NR',
  poster_url    TEXT,
  backdrop_url  TEXT,
  trailer_key   TEXT,                     -- YouTube key (from TMDB sync)
  stream_source TEXT,                     -- archive.org identifier for free-to-stream films
  stream_url    TEXT,                     -- resolved direct video file
  providers     TEXT[] DEFAULT '{}',      -- where to watch (from TMDB sync)
  tmdb_rating   REAL,
  popularity    REAL DEFAULT 0,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX movies_title_idx ON movies (LOWER(title));
CREATE INDEX movies_genres_idx ON movies USING GIN (genres);

CREATE TABLE reviews (
  id                 SERIAL PRIMARY KEY,
  user_id            INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  movie_id           INT NOT NULL REFERENCES movies(id) ON DELETE CASCADE,
  rating             NUMERIC(2,1) CHECK (rating IS NULL OR (rating >= 0.5 AND rating <= 5)),
  liked              BOOLEAN DEFAULT FALSE,
  body               TEXT DEFAULT '',
  watched_on         DATE DEFAULT CURRENT_DATE,
  rewatch            BOOLEAN DEFAULT FALSE,
  author_spoiler     BOOLEAN DEFAULT FALSE, -- author ticked "contains spoilers"
  spoiler_score      REAL DEFAULT 0,        -- ML: max sentence probability
  spoiler_sentences  JSONB DEFAULT '[]',    -- ML: [{start,end,score}] spans to blur
  created_at         TIMESTAMPTZ DEFAULT NOW(),
  updated_at         TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (user_id, movie_id)
);
CREATE INDEX reviews_movie_idx ON reviews (movie_id);

CREATE TABLE review_likes (
  user_id   INT REFERENCES users(id) ON DELETE CASCADE,
  review_id INT REFERENCES reviews(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, review_id)
);

-- Community spoiler reports feed back into the spoiler model's training data
CREATE TABLE spoiler_reports (
  user_id   INT REFERENCES users(id) ON DELETE CASCADE,
  review_id INT REFERENCES reviews(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, review_id)
);

CREATE TABLE watchlist (
  user_id  INT REFERENCES users(id) ON DELETE CASCADE,
  movie_id INT REFERENCES movies(id) ON DELETE CASCADE,
  added_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, movie_id)
);

CREATE TABLE watch_history (
  user_id          INT REFERENCES users(id) ON DELETE CASCADE,
  movie_id         INT REFERENCES movies(id) ON DELETE CASCADE,
  position_seconds INT DEFAULT 0,
  duration_seconds INT DEFAULT 0,
  completed        BOOLEAN DEFAULT FALSE,
  started_at       TIMESTAMPTZ DEFAULT NOW(),
  last_watched_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, movie_id)
);
CREATE INDEX watch_recent_idx ON watch_history (last_watched_at);

CREATE TABLE follows (
  follower_id INT REFERENCES users(id) ON DELETE CASCADE,
  followee_id INT REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (follower_id, followee_id)
);

-- Group mode ("watch party" rooms)
CREATE TABLE watch_rooms (
  id            SERIAL PRIMARY KEY,
  code          TEXT UNIQUE NOT NULL,
  host_id       INT REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'lobby' CHECK (status IN ('lobby','voting','done')),
  filters       JSONB DEFAULT '{}',
  candidate_ids INT[] DEFAULT '{}',
  scores        JSONB DEFAULT '{}',   -- movie_id -> {member_id: match}
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE room_members (
  room_id   INT REFERENCES watch_rooms(id) ON DELETE CASCADE,
  user_id   INT REFERENCES users(id) ON DELETE CASCADE,
  finished  BOOLEAN DEFAULT FALSE,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (room_id, user_id)
);

CREATE TABLE room_votes (
  room_id  INT REFERENCES watch_rooms(id) ON DELETE CASCADE,
  user_id  INT REFERENCES users(id) ON DELETE CASCADE,
  movie_id INT REFERENCES movies(id) ON DELETE CASCADE,
  vote     SMALLINT NOT NULL CHECK (vote IN (-1, 1, 2)),  -- nope, yes, love
  PRIMARY KEY (room_id, user_id, movie_id)
);

-- Community stats per film (Letterboxd-style average, count, likes)
CREATE VIEW movie_stats AS
SELECT m.id AS movie_id,
       ROUND(AVG(r.rating)::numeric, 2)          AS avg_rating,
       COUNT(r.rating)::int                      AS n_ratings,
       COUNT(*) FILTER (WHERE r.liked)::int      AS n_likes,
       COUNT(*) FILTER (WHERE r.body <> '')::int AS n_reviews
FROM movies m LEFT JOIN reviews r ON r.movie_id = m.id
GROUP BY m.id;
