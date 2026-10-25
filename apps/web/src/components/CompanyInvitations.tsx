import { Trans, useLingui } from "@lingui/react/macro";
import { Button, Input } from "@rakazo/ui-web";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rakazo/ui-web/components/ui/collapsible";
import { useEffect, useState } from "react";
import { rpc, selectSpace } from "../lib/rpc";
import { errorText } from "../lib/user-error";

type Invitation = Awaited<ReturnType<typeof rpc.companyInvitations.create>>;
type Preview = Awaited<ReturnType<typeof rpc.companyInvitations.preview>>;

export function CompanyInvitations({
  onJoined = () => window.location.assign("/app"),
}: {
  onJoined?: () => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [canInvite, setCanInvite] = useState(false);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [token, setToken] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [acceptedSpaceId, setAcceptedSpaceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let current = true;
    void rpc.companyInvitations
      .capabilities({})
      .then((result) => {
        if (current) setCanInvite(result.canInvite);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [open]);

  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  async function accept() {
    const spaceId =
      acceptedSpaceId ?? (await rpc.companyInvitations.accept({ token: token.trim() })).spaceId;
    setAcceptedSpaceId(spaceId);
    if (!selectSpace(spaceId)) throw new Error(t`Could not switch company`);
    setToken("");
    setPreview(null);
    onJoined();
  }

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-xl border border-border"
      data-testid="company-invitations"
    >
      <CollapsibleTrigger className="min-h-11 w-full px-4 text-start text-sm font-medium">
        <Trans>Company</Trans>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 border-t border-border p-4">
        {canInvite ? (
          <div className="space-y-2">
            {invitation ? (
              <>
                <Input
                  aria-label={t`Created invitation code`}
                  value={invitation.token}
                  readOnly
                  autoComplete="off"
                />
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await navigator.clipboard.writeText(invitation.token);
                      })
                    }
                  >
                    <Trans>Copy invitation</Trans>
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void perform(async () => {
                        await rpc.companyInvitations.revoke({ invitationId: invitation.id });
                        setInvitation(null);
                      })
                    }
                  >
                    <Trans>Revoke invitation</Trans>
                  </Button>
                </div>
              </>
            ) : (
              <Button
                size="sm"
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void perform(async () => {
                    setInvitation(await rpc.companyInvitations.create({}));
                  })
                }
              >
                <Trans>Invite member</Trans>
              </Button>
            )}
          </div>
        ) : null}
        <div className="space-y-2">
          <Input
            aria-label={t`Invitation code`}
            placeholder={t`Invitation code`}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={token}
            disabled={busy || Boolean(acceptedSpaceId)}
            onChange={(event) => {
              setToken(event.target.value);
              setPreview(null);
            }}
          />
          {preview ? (
            <div className="space-y-2">
              <p className="text-sm" dir="auto">
                {preview.organizationName} · {preview.spaceName}
              </p>
              <p className="text-sm text-muted-foreground">
                <Trans>Bot access is granted separately.</Trans>
              </p>
              <Button size="sm" disabled={busy} onClick={() => void perform(accept)}>
                {acceptedSpaceId ? <Trans>Open company</Trans> : <Trans>Join company</Trans>}
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              variant="secondary"
              disabled={busy || !token.trim()}
              onClick={() =>
                void perform(async () => {
                  setPreview(await rpc.companyInvitations.preview({ token: token.trim() }));
                })
              }
            >
              <Trans>Preview invitation</Trans>
            </Button>
          )}
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
