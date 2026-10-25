-- Additive: older releases do not read or write this product-owned invitation table.
CREATE TABLE "company_invitations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "organizationId" TEXT NOT NULL,
  "spaceId" TEXT NOT NULL,
  "inviterUserId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "acceptedByUserId" TEXT,
  "revokedAt" TIMESTAMP(3),
  CONSTRAINT "company_invitations_space_fkey" FOREIGN KEY ("spaceId", "organizationId")
    REFERENCES "spaces"("id", "organizationId") ON DELETE CASCADE,
  CONSTRAINT "company_invitations_inviter_fkey" FOREIGN KEY ("inviterUserId")
    REFERENCES "user"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "company_invitations_tokenHash_key" ON "company_invitations"("tokenHash");
CREATE INDEX "company_invitations_spaceId_expiresAt_idx" ON "company_invitations"("spaceId", "expiresAt");

ALTER TABLE "company_invitations" ENABLE ROW LEVEL SECURITY;
-- Tokens are capabilities, not tenant-readable data. Only the focused invitation
-- service may cross tenants, after authenticating and checking the token or admin.
CREATE POLICY company_invitations_system ON "company_invitations"
  USING (current_setting('app.rls_bypass', true) = 'on')
  WITH CHECK (current_setting('app.rls_bypass', true) = 'on');
