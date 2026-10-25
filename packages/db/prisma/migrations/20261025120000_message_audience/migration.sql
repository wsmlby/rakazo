-- Additive: older releases ignore the column, so they keep working while this deploys.
ALTER TABLE "messages" ADD COLUMN "audienceUserId" TEXT;
CREATE INDEX "messages_threadId_audienceUserId_seq_idx" ON "messages"("threadId", "audienceUserId", "seq");

-- A collaborator's own messages, and the bot's replies to runs they requested,
-- move out of the owner's thread into that collaborator's private exchange.
UPDATE "messages" m SET "audienceUserId" = m."authorUserId"
FROM "threads" t
WHERE m."threadId" = t."id" AND m."authorUserId" IS NOT NULL AND m."authorUserId" <> t."userId";

UPDATE "messages" m SET "audienceUserId" = r."requesterUserId"
FROM "runs" r
WHERE m."runId" = r."id" AND m."audienceUserId" IS NULL
  AND r."requesterUserId" IS NOT NULL AND r."requesterUserId" <> r."userId";

-- A collaborator reads only their own exchange; the thread's owner reads every message.
CREATE POLICY messages_audience_read ON messages AS RESTRICTIVE FOR SELECT USING (
  app_rls_version() < 3 OR current_setting('app.rls_bypass', true) = 'on'
  OR "audienceUserId" = NULLIF(current_setting('app.user_id', true), '')
  OR EXISTS (SELECT 1 FROM threads t WHERE t.id = "threadId"
    AND t."userId" = NULLIF(current_setting('app.user_id', true), ''))
);
