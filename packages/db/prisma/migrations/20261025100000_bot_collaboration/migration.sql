ALTER TABLE bots ADD COLUMN "collaborationRestricted" boolean NOT NULL DEFAULT false;
ALTER TABLE messages ADD COLUMN "authorUserId" text, ADD COLUMN "authorName" text;
ALTER TABLE tasks ADD COLUMN "requesterUserId" text;
ALTER TABLE runs ADD COLUMN "requesterUserId" text;

CREATE TABLE bot_collaborators (
  "botId" text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  "userId" text NOT NULL,
  "spaceId" text NOT NULL,
  "canApprove" boolean NOT NULL DEFAULT false,
  "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("botId", "userId"),
  FOREIGN KEY ("spaceId", "userId") REFERENCES space_members("spaceId", "userId") ON DELETE CASCADE
);
CREATE INDEX bot_collaborators_space_user_idx ON bot_collaborators("spaceId", "userId");
CREATE TABLE bot_user_preferences (
  "botId" text NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
  "userId" text NOT NULL,
  "spaceId" text NOT NULL,
  pinned boolean NOT NULL DEFAULT false,
  "sectionId" text REFERENCES bot_sections(id) ON DELETE SET NULL,
  "notifyOnFinish" boolean NOT NULL DEFAULT true,
  "autoSpeak" boolean NOT NULL DEFAULT false,
  "lastReadSeq" integer NOT NULL DEFAULT -1,
  "manualUnread" boolean NOT NULL DEFAULT false,
  PRIMARY KEY ("botId", "userId"),
  FOREIGN KEY ("spaceId", "userId") REFERENCES space_members("spaceId", "userId") ON DELETE CASCADE
);
CREATE INDEX bot_user_preferences_space_user_idx ON bot_user_preferences("spaceId", "userId");

-- Definer helpers avoid policy recursion; arguments never choose the current user or Space.
CREATE FUNCTION app_can_read_bot(target text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (
      SELECT 1 FROM bots b
      JOIN spaces s ON s.id = b."spaceId"
      JOIN space_members sm ON sm."spaceId" = s.id AND sm."organizationId" = s."organizationId"
      JOIN member m ON m."organizationId" = sm."organizationId" AND m."userId" = sm."userId"
      WHERE b.id = target
        AND b."spaceId" = NULLIF(current_setting('app.space_id', true), '')
        AND sm."userId" = NULLIF(current_setting('app.user_id', true), '')
        AND (b."userId" = sm."userId" OR EXISTS (
          SELECT 1 FROM bot_collaborators c
          WHERE c."botId" = b.id AND c."spaceId" = b."spaceId" AND c."userId" = sm."userId"
        ))
    )
  $$;
CREATE FUNCTION app_can_read_thread(target text) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
    SELECT EXISTS (
      SELECT 1 FROM threads t WHERE t.id = target
      AND t."spaceId" = NULLIF(current_setting('app.space_id', true), '')
      AND (CASE WHEN t."botId" IS NOT NULL THEN app_can_read_bot(t."botId")
           ELSE t."userId" = NULLIF(current_setting('app.user_id', true), '') END)
    )
  $$;

ALTER TABLE bot_collaborators ENABLE ROW LEVEL SECURITY;
CREATE POLICY bot_collaborators_system ON bot_collaborators USING (current_setting('app.rls_bypass', true) = 'on');
CREATE POLICY bot_collaborators_read ON bot_collaborators FOR SELECT USING (app_can_read_bot("botId"));
CREATE POLICY bot_collaborators_owner ON bot_collaborators FOR ALL USING (
  EXISTS (SELECT 1 FROM bots b WHERE b.id = "botId" AND b."spaceId" = bot_collaborators."spaceId"
    AND b."spaceId" = NULLIF(current_setting('app.space_id', true), '')
    AND b."userId" = NULLIF(current_setting('app.user_id', true), ''))
);
ALTER TABLE bot_user_preferences ENABLE ROW LEVEL SECURITY;
CREATE POLICY bot_user_preferences_system ON bot_user_preferences USING (current_setting('app.rls_bypass', true) = 'on');
CREATE POLICY bot_user_preferences_user ON bot_user_preferences USING (
  "userId" = NULLIF(current_setting('app.user_id', true), '') AND app_can_read_bot("botId")
  AND "spaceId" = NULLIF(current_setting('app.space_id', true), '')
);

-- Version 3 only: the previous release retains its existing policies during rolling deploys.
CREATE POLICY bots_collaboration_read ON bots AS RESTRICTIVE FOR SELECT USING (
  app_rls_version() < 3 OR current_setting('app.rls_bypass', true) = 'on'
  OR ("userId" = NULLIF(current_setting('app.user_id', true), '') AND EXISTS (
    SELECT 1 FROM space_members sm JOIN spaces s ON s.id = sm."spaceId" AND s."organizationId" = sm."organizationId"
    WHERE sm."spaceId" = bots."spaceId" AND sm."userId" = bots."userId"
  ))
  OR app_can_read_bot(id)
);
CREATE POLICY bots_collaboration_update ON bots AS RESTRICTIVE FOR UPDATE USING (
  app_rls_version() < 3 OR current_setting('app.rls_bypass', true) = 'on'
  OR "userId" = NULLIF(current_setting('app.user_id', true), '')
);
CREATE POLICY bots_collaboration_delete ON bots AS RESTRICTIVE FOR DELETE USING (
  app_rls_version() < 3 OR current_setting('app.rls_bypass', true) = 'on'
  OR "userId" = NULLIF(current_setting('app.user_id', true), '')
);
CREATE POLICY computers_collaboration_update ON computers AS RESTRICTIVE FOR UPDATE USING (
  app_rls_version() < 3 OR current_setting('app.rls_bypass', true) = 'on'
  OR "userId" = NULLIF(current_setting('app.user_id', true), '')
);
CREATE POLICY threads_collaboration_read ON threads AS RESTRICTIVE FOR SELECT USING (
  app_rls_version() < 3 OR current_setting('app.rls_bypass', true) = 'on'
  OR ("userId" = NULLIF(current_setting('app.user_id', true), '') AND EXISTS (
    SELECT 1 FROM space_members sm JOIN spaces s ON s.id = sm."spaceId" AND s."organizationId" = sm."organizationId"
    WHERE sm."spaceId" = threads."spaceId" AND sm."userId" = threads."userId"
  ))
  OR app_can_read_thread(id)
);
CREATE POLICY messages_collaboration_read ON messages AS RESTRICTIVE FOR SELECT USING (
  app_rls_version() < 3 OR current_setting('app.rls_bypass', true) = 'on' OR app_can_read_thread("threadId")
);
CREATE POLICY messages_collaboration_delete ON messages AS RESTRICTIVE FOR DELETE USING (
  app_rls_version() < 3 OR current_setting('app.rls_bypass', true) = 'on'
  OR EXISTS (SELECT 1 FROM threads t WHERE t.id = "threadId"
    AND t."userId" = NULLIF(current_setting('app.user_id', true), ''))
);
CREATE POLICY events_collaboration_read ON events AS RESTRICTIVE FOR SELECT USING (
  app_rls_version() < 3 OR current_setting('app.rls_bypass', true) = 'on' OR app_can_read_thread("threadId")
);
CREATE POLICY runs_collaboration_read ON runs AS RESTRICTIVE FOR SELECT USING (
  app_rls_version() < 3 OR current_setting('app.rls_bypass', true) = 'on' OR app_can_read_bot("botId")
);
CREATE POLICY tasks_collaboration_read ON tasks AS RESTRICTIVE FOR SELECT USING (
  app_rls_version() < 3 OR current_setting('app.rls_bypass', true) = 'on' OR app_can_read_bot("botId")
);

-- An older worker does not understand the conversation-only boundary. It must not
-- claim these runs during the rolling-deployment overlap, even with system RLS.
CREATE POLICY runs_collaboration_worker_version ON runs AS RESTRICTIVE FOR UPDATE USING (
  app_rls_version() >= 3 OR NOT EXISTS (
    SELECT 1 FROM bots b WHERE b.id = runs."botId" AND b."collaborationRestricted"
  )
);

CREATE FUNCTION protect_shared_bot_computer() RETURNS trigger
  LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  BEGIN
    IF TG_OP = 'UPDATE' AND OLD."collaborationRestricted" AND NOT NEW."collaborationRestricted" THEN
      RAISE EXCEPTION 'Shared conversation restriction cannot be removed';
    END IF;
    IF NEW."computerId" IS NOT NULL THEN
      PERFORM id FROM computers WHERE id = NEW."computerId" FOR UPDATE;
      IF NEW."collaborationRestricted" AND NOT EXISTS (
        SELECT 1 FROM computers c WHERE c.id = NEW."computerId"
          AND c.scope = 'dedicated' AND c.kind <> 'desktop' AND c."homeKey" = NEW.id
          AND c."spaceId" = NEW."spaceId" AND c."userId" = NEW."userId"
      ) THEN RAISE EXCEPTION 'Shared bots require their own dedicated computer'; END IF;
      IF EXISTS (
        SELECT 1 FROM bots b WHERE b."computerId" = NEW."computerId" AND b.id <> NEW.id
          AND (NEW."collaborationRestricted" OR b."collaborationRestricted")
      ) THEN RAISE EXCEPTION 'Shared bot computers cannot host unrelated bots'; END IF;
    END IF;
    RETURN NEW;
  END $$;
CREATE TRIGGER protect_shared_bot_computer BEFORE INSERT OR UPDATE OF "computerId", "collaborationRestricted", "userId"
  ON bots FOR EACH ROW EXECUTE FUNCTION protect_shared_bot_computer();
