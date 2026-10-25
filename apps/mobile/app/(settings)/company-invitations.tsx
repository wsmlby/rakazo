import type { AppContract } from "@rakazo/contracts";
import * as Clipboard from "expo-clipboard";
import { Stack, useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { ScrollView, Text, TextInput } from "react-native";
import { glassHeaderOptions } from "../../components/glass-title";
import { NativeActionButton } from "../../components/native-action-button";
import { SettingsGroup } from "../../components/settings-group";
import { rpc, selectSpace } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { native, useMobileTokens } from "../../lib/native";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";

type Invitation = ReturnType<
  NonNullable<AppContract["companyInvitations"]["create"]["~orpc"]["outputSchema"]>["parse"]
>;
type Preview = ReturnType<
  NonNullable<AppContract["companyInvitations"]["preview"]["~orpc"]["outputSchema"]>["parse"]
>;

export default function CompanyInvitationsScreen() {
  const { t } = useI18n();
  const router = useRouter();
  const tokens = useMobileTokens();
  const sideInsets = useSideInsets();
  const [canInvite, setCanInvite] = useState(false);
  const [invitation, setInvitation] = useState<Invitation | null>(null);
  const [token, setToken] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [acceptedSpaceId, setAcceptedSpaceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void rpc<{ canInvite: boolean }>("companyInvitations/capabilities", {})
      .then((result) => {
        if (current) setCanInvite(result.canInvite);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);

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
      acceptedSpaceId ??
      (await rpc<{ spaceId: string }>("companyInvitations/accept", { token: token.trim() }))
        .spaceId;
    setAcceptedSpaceId(spaceId);
    await selectSpace(spaceId);
    setToken("");
    setPreview(null);
    router.dismissAll();
    router.replace("/");
  }
  return (
    <>
      <Stack.Screen options={glassHeaderOptions(t("Company"))} />
      <ScrollView
        style={[{ flex: 1, backgroundColor: native.groupedPage }, sideInsets]}
        contentContainerStyle={{ padding: 24, gap: 24 }}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        {canInvite ? (
          <SettingsGroup>
            {invitation ? (
              <>
                <Text selectable style={{ color: tokens.foreground }}>
                  {invitation.token}
                </Text>
                <NativeActionButton
                  label={t("Copy invitation")}
                  prominence="secondary"
                  disabled={busy}
                  onPress={() =>
                    void perform(async () => {
                      await Clipboard.setStringAsync(invitation.token);
                    })
                  }
                />
                <NativeActionButton
                  label={t("Revoke invitation")}
                  prominence="destructive"
                  disabled={busy}
                  onPress={() =>
                    void perform(async () => {
                      await rpc("companyInvitations/revoke", { invitationId: invitation.id });
                      setInvitation(null);
                    })
                  }
                />
              </>
            ) : (
              <NativeActionButton
                label={t("Invite member")}
                prominence="secondary"
                disabled={busy}
                onPress={() =>
                  void perform(async () => {
                    setInvitation(await rpc<Invitation>("companyInvitations/create", {}));
                  })
                }
              />
            )}
          </SettingsGroup>
        ) : null}
        <SettingsGroup>
          <TextInput
            accessibilityLabel={t("Invitation code")}
            placeholder={t("Invitation code")}
            placeholderTextColor={tokens.mutedForeground}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="off"
            value={token}
            editable={!busy && !acceptedSpaceId}
            onChangeText={(value) => {
              setToken(value);
              setPreview(null);
            }}
            style={{ color: tokens.foreground, padding: 16 }}
          />
          {preview ? (
            <>
              <Text style={{ color: tokens.foreground }}>
                {preview.organizationName} · {preview.spaceName}
              </Text>
              <Text style={{ color: tokens.mutedForeground }}>
                {t("Bot access is granted separately.")}
              </Text>
              <NativeActionButton
                label={acceptedSpaceId ? t("Open company") : t("Join company")}
                disabled={busy}
                onPress={() => void perform(accept)}
              />
            </>
          ) : (
            <NativeActionButton
              label={t("Preview invitation")}
              prominence="secondary"
              disabled={busy || !token.trim()}
              onPress={() =>
                void perform(async () => {
                  setPreview(
                    await rpc<Preview>("companyInvitations/preview", { token: token.trim() }),
                  );
                })
              }
            />
          )}
        </SettingsGroup>
        {error ? (
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </>
  );
}
