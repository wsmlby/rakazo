import { Trans, useLingui } from "@lingui/react/macro";
import type { ComputerMode } from "@rakazo/contracts";
import { Button, NativeSelect, NativeSelectOption, Switch } from "@rakazo/ui-web";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rakazo/ui-web/components/ui/collapsible";
import { useEffect, useState } from "react";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";

type Sharing = Awaited<ReturnType<typeof rpc.bots.sharing.get>>;

export function BotSharing({
  botId,
  onChanged,
  computerMode,
  onUsePrivateComputer,
  onOpenCompany,
}: {
  botId: string;
  onChanged: (transferred?: boolean) => Promise<void>;
  computerMode?: ComputerMode;
  onUsePrivateComputer?: () => Promise<void>;
  onOpenCompany?: () => void;
}) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [sharing, setSharing] = useState<Sharing | null>(null);
  const [userId, setUserId] = useState("");
  const [transfer, setTransfer] = useState<Sharing["members"][number] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let current = true;
    const refresh = () => {
      void rpc.bots.sharing
        .get({ botId })
        .then((next) => {
          if (current) setSharing(next);
        })
        .catch((cause) => {
          if (current) setError(errorText(cause));
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      current = false;
      window.removeEventListener("focus", refresh);
    };
  }, [botId, open]);

  async function change(action: () => Promise<unknown>, transferred = false) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await onChanged(transferred);
      if (transferred) {
        setTransfer(null);
      } else {
        setSharing(await rpc.bots.sharing.get({ botId }));
        setUserId("");
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-4" data-testid="bot-sharing">
      <CollapsibleTrigger className="text-sm font-medium">
        <Trans>Sharing</Trans>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-4 pt-3">
        <p className="text-sm text-muted-foreground">
          <Trans>
            Members can read all past and future messages and use this bot’s memory. Sharing
            permanently disables tools. Replies use the owner’s model connection.
          </Trans>
        </p>
        {onOpenCompany ? (
          <Button variant="ghost" size="sm" onClick={onOpenCompany}>
            <Trans>Company</Trans>
          </Button>
        ) : null}
        {computerMode === "team" ? (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              <Trans>Sharing requires a private computer.</Trans>
            </p>
            <Button
              size="sm"
              disabled={busy || !onUsePrivateComputer}
              onClick={() =>
                void change(async () => {
                  await onUsePrivateComputer?.();
                })
              }
            >
              <Trans>Use private computer</Trans>
            </Button>
          </div>
        ) : sharing?.eligibleMembers.some(
            (member) => !sharing.members.some((existing) => existing.userId === member.userId),
          ) ? (
          <div className="flex gap-2">
            <NativeSelect
              aria-label={t`Company member`}
              value={userId}
              onChange={(event) => setUserId(event.target.value)}
              disabled={busy}
            >
              <NativeSelectOption value="">{t`Choose member`}</NativeSelectOption>
              {sharing.eligibleMembers
                .filter(
                  (member) =>
                    !sharing.members.some((existing) => existing.userId === member.userId),
                )
                .map((member) => (
                  <NativeSelectOption key={member.userId} value={member.userId}>
                    {member.name}
                  </NativeSelectOption>
                ))}
            </NativeSelect>
            <Button
              size="sm"
              disabled={busy || !userId}
              onClick={() => void change(() => rpc.bots.sharing.grant({ botId, userId }))}
            >
              <Trans>Add</Trans>
            </Button>
          </div>
        ) : null}
        {sharing?.members.map((member) => (
          <div key={member.userId} className="space-y-2 border-t border-border pt-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm" dir="auto">
                {member.name}
              </span>
              <Button
                variant="ghost"
                size="sm"
                aria-label={t`Remove ${member.name}`}
                disabled={busy}
                onClick={() =>
                  void change(() => rpc.bots.sharing.revoke({ botId, userId: member.userId }))
                }
              >
                <Trans>Remove</Trans>
              </Button>
            </div>
            <div className="flex items-center justify-between gap-3 text-sm">
              <Trans>Allow approvals</Trans>
              <Switch
                aria-label={t`Allow approvals for ${member.name}`}
                checked={member.canApprove}
                disabled={busy}
                onCheckedChange={(canApprove) =>
                  void change(() =>
                    rpc.bots.sharing.grant({ botId, userId: member.userId, canApprove }),
                  )
                }
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t`Transfer ownership to ${member.name}`}
              disabled={busy}
              onClick={() => setTransfer(member)}
            >
              <Trans>Transfer ownership</Trans>
            </Button>
          </div>
        ))}
        {transfer ? (
          <div className="space-y-2 rounded-md border border-border p-3">
            <p className="text-sm">
              <Trans>Transfer ownership to {transfer.name}?</Trans>
            </p>
            <p className="text-sm text-muted-foreground">
              <Trans>
                Bot connections and credentials are removed; routines are paused. Replies use the
                new owner’s model connection.
              </Trans>
            </p>
            <div className="flex gap-2">
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() =>
                  void change(
                    () => rpc.bots.sharing.transfer({ botId, userId: transfer.userId }),
                    true,
                  )
                }
              >
                <Trans>Transfer</Trans>
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => setTransfer(null)}>
                <Trans>Cancel</Trans>
              </Button>
            </div>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}
