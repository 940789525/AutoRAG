/** Application tables only. DBOS owns its independent research_dbos schema. */
export const RESEARCH_SCHEMA = `
CREATE SCHEMA IF NOT EXISTS research;
CREATE TABLE IF NOT EXISTS research.migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE research.libraries (
 id uuid PRIMARY KEY, name text NOT NULL, root_path text NOT NULL UNIQUE,
 workspace_path text NOT NULL UNIQUE, state text NOT NULL DEFAULT 'seeding'
 CHECK(state IN ('seeding','active','paused','error')), last_scan_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE research.papers (
 id uuid PRIMARY KEY, library_id uuid NOT NULL REFERENCES research.libraries(id), title text,
 doi text, arxiv_id text, identity_state text NOT NULL DEFAULT 'provisional',
 UNIQUE(library_id,id)
);
CREATE UNIQUE INDEX papers_doi ON research.papers(library_id,doi) WHERE doi IS NOT NULL;
CREATE UNIQUE INDEX papers_arxiv ON research.papers(library_id,arxiv_id) WHERE arxiv_id IS NOT NULL;
CREATE TABLE research.batches (
 id uuid PRIMARY KEY, library_id uuid NOT NULL REFERENCES research.libraries(id), kind text NOT NULL,
 status text NOT NULL DEFAULT 'planned', baseline jsonb NOT NULL DEFAULT '[]',
 manifest_digest text NOT NULL, dispatch_state text NOT NULL DEFAULT 'pending',
 counts jsonb NOT NULL DEFAULT '{}', error text,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz, UNIQUE(library_id,id)
);
CREATE UNIQUE INDEX one_active_batch ON research.batches(library_id)
 WHERE status IN ('planned','scanning','indexing');
CREATE TABLE research.paper_assets (
 id uuid PRIMARY KEY, library_id uuid NOT NULL, paper_id uuid NOT NULL,
 sha256 text NOT NULL, size bigint NOT NULL, state text NOT NULL DEFAULT 'identified',
 first_batch_id uuid NOT NULL, source_id text, source_path text, output_sha256 text,
 error text, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(library_id,id), UNIQUE(library_id,sha256),
 FOREIGN KEY(library_id,paper_id) REFERENCES research.papers(library_id,id),
 FOREIGN KEY(library_id,first_batch_id) REFERENCES research.batches(library_id,id)
);
CREATE TABLE research.file_locations (
 id uuid PRIMARY KEY, library_id uuid NOT NULL REFERENCES research.libraries(id), asset_id uuid,
 path text NOT NULL, size bigint NOT NULL, mtime text NOT NULL,
 state text NOT NULL DEFAULT 'waiting', last_seen_at timestamptz NOT NULL DEFAULT now(), error text,
 UNIQUE(library_id,id), UNIQUE(library_id,path),
 FOREIGN KEY(library_id,asset_id) REFERENCES research.paper_assets(library_id,id)
);
CREATE TABLE research.batch_items (
 id uuid PRIMARY KEY, library_id uuid NOT NULL, batch_id uuid NOT NULL, location_id uuid NOT NULL,
 asset_id uuid, kind text NOT NULL, stage text NOT NULL, error text,
 UNIQUE(batch_id,location_id),
 FOREIGN KEY(library_id,batch_id) REFERENCES research.batches(library_id,id),
 FOREIGN KEY(library_id,location_id) REFERENCES research.file_locations(library_id,id),
 FOREIGN KEY(library_id,asset_id) REFERENCES research.paper_assets(library_id,id)
);
CREATE TABLE research.topics (
 id uuid PRIMARY KEY, library_id uuid NOT NULL REFERENCES research.libraries(id), title text NOT NULL,
 question text NOT NULL, focus jsonb NOT NULL DEFAULT '[]', exclusions jsonb NOT NULL DEFAULT '[]',
 revision integer NOT NULL DEFAULT 1, active boolean NOT NULL DEFAULT true, UNIQUE(library_id,id)
);
CREATE TABLE research.analysis_runs (
 id uuid PRIMARY KEY, library_id uuid NOT NULL, batch_id uuid NOT NULL,
 asset_id uuid NOT NULL, topic_id uuid NOT NULL, topic_snapshot jsonb NOT NULL,
 target jsonb NOT NULL, baseline jsonb NOT NULL, base_key text NOT NULL, generation integer NOT NULL DEFAULT 0,
 workflow_id text NOT NULL UNIQUE, dispatch_state text NOT NULL DEFAULT 'pending',
 state text NOT NULL DEFAULT 'planned', deep_read_reserved boolean NOT NULL DEFAULT false, cancel_requested boolean NOT NULL DEFAULT false,
 result jsonb, error text, last_event_seq integer NOT NULL DEFAULT 0,
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
 UNIQUE(base_key,generation), UNIQUE(library_id,id),
 FOREIGN KEY(library_id,batch_id) REFERENCES research.batches(library_id,id),
 FOREIGN KEY(library_id,asset_id) REFERENCES research.paper_assets(library_id,id),
 FOREIGN KEY(library_id,topic_id) REFERENCES research.topics(library_id,id)
);
CREATE TABLE research.inbox_items (
 id uuid PRIMARY KEY, library_id uuid NOT NULL, run_id uuid NOT NULL UNIQUE,
 topic_id uuid NOT NULL, asset_id uuid NOT NULL, payload jsonb NOT NULL, evidence jsonb NOT NULL,
 priority text NOT NULL, relevance text NOT NULL, review_state text NOT NULL DEFAULT 'unread',
 validity text NOT NULL DEFAULT 'verified', created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY(library_id,run_id) REFERENCES research.analysis_runs(library_id,id),
 FOREIGN KEY(library_id,topic_id) REFERENCES research.topics(library_id,id),
 FOREIGN KEY(library_id,asset_id) REFERENCES research.paper_assets(library_id,id)
);
CREATE TABLE research.feedback (
 id uuid PRIMARY KEY, item_id uuid NOT NULL REFERENCES research.inbox_items(id),
 kind text NOT NULL, value text NOT NULL, comment text, UNIQUE(item_id,kind)
);
CREATE TABLE research.run_events (
 run_id uuid NOT NULL REFERENCES research.analysis_runs(id), seq integer NOT NULL,
 type text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(run_id,seq)
);
CREATE TABLE research.api_requests (
 key text NOT NULL, route text NOT NULL, digest text NOT NULL, response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(key,route)
);
CREATE INDEX inbox_listing ON research.inbox_items(created_at DESC,id);
CREATE INDEX pending_runs ON research.analysis_runs(dispatch_state) WHERE dispatch_state='pending';
INSERT INTO research.migrations(version) VALUES (1);
`;
