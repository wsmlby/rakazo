import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useState } from "react";
import { Alert, AppState, RefreshControl, ScrollView, Text } from "react-native";
import { glassHeaderOptions } from "../components/glass-title";
import { MenuPicker } from "../components/menu-picker";
import { NativeActionButton } from "../components/native-action-button";
import { SettingsGroup, SettingsRow, SettingsSwitch } from "../components/settings-group";
import type { MobileBot, MobileBotSharing } from "../lib/api";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

export default function BotSharingScreen() {
  const { botId = "" } = useLocalSearchParams<{ botId?: string }>();
  const { t } = useI18n();
  const router = useRouter();
  const tokens = useMobileTokens();
  const sideInsets = useSideInsets();
  const [sharing, setSharing] = useState<MobileBotSharing | null>(null);
  const [owner, setOwner] = useState(false);
  const [computerMode, setComputerMode] = useState<MobileBot["computerMode"]>();
  const [userId, setUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [revision, setRevision] = useState(0);

  useFocusEffect(
    useCallback(() => {
      let current = true;
      const refresh = () => {
        setRefreshing(true);
        void rpc<MobileBot>("bots/get", { botId })
          .then(async (bot) => {
            if (!current) return;
            if (bot.accessRole === "collaborator") {
              setOwner(false);
              setSharing(null);
              return;
            }
            setOwner(true);
            setComputerMode(bot.computerMode);
            const next = await rpc<MobileBotSharing>("bots/sharing/get", { botId });
            if (current) setSharing(next);
          })
          .catch((cause) => {
            if (current) {
              setOwner(false);
              setSharing(null);
              setError(errorText(cause));
            }
          })
          .finally(() => {
            if (current) setRefreshing(false);
          });
      };
      refresh();
      const subscription = AppState.addEventListener("change", (state) => {
        if (state === "active") refresh();
      });
      return () => {
        current = false;
        subscription.remove();
      };
    }, [botId, revision]),
  );

  async function change(action: () => Promise<unknown>, transferred = false) {
    if (!owner || busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
      if (transferred) {
        router.dismissTo({ pathname: "/thread", params: { botId } });
      } else {
        setSharing(await rpc<MobileBotSharing>("bots/sharing/get", { botId }));
        setUserId("");
      }
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Stack.Screen options={glassHeaderOptions(t("Sharing"))} />
      <ScrollView
        style={[{ flex: 1, backgroundColor: tokens.background }, sideInsets]}
        contentContainerStyle={{ padding: 24, gap: 24 }}
        contentInsetAdjustmentBehavior="automatic"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => setRevision((value) => value + 1)}
          />
        }
      >
        {owner ? (
          <>
            <Text style={{ color: tokens.mutedForeground }}>
              {t(
                "Members can read all past and future messages and use this bot’s memory. Sharing permanently disables tools. Replies use the owner’s model connection.",
              )}
            </Text>
            <NativeActionButton
              label={t("Company")}
              prominence="plain"
              onPress={() => router.push("/company-invitations")}
            />
            {computerMode === "team" ? (
              <SettingsGroup footer={t("Sharing requires a private computer.")}>
                <SettingsRow
                  title={t("Use private computer")}
                  accessibilityRole="button"
                  disabled={busy}
                  onPress={() =>
                    void change(async () => {
                      await rpc("bots/setComputer", { botId, mode: "dedicated" });
                      setComputerMode("dedicated");
                    })
                  }
                />
              </SettingsGroup>
            ) : sharing?.eligibleMembers.some(
                (member) => !sharing.members.some((existing) => existing.userId === member.userId),
              ) ? (
              <SettingsGroup>
                <MenuPicker
                  label={t("Company member")}
                  value={userId}
                  choices={[
                    { key: "", label: t("Choose member") },
                    ...sharing.eligibleMembers
                      .filter(
                        (member) =>
                          !sharing.members.some((existing) => existing.userId === member.userId),
                      )
                      .map((member) => ({
                        key: member.userId,
                        label: member.name,
                      })),
                  ]}
                  onChange={setUserId}
                />
                <NativeActionButton
                  label={t("Add")}
                  disabled={!userId || busy}
                  onPress={() => void change(() => rpc("bots/sharing/grant", { botId, userId }))}
                />
              </SettingsGroup>
            ) : null}
            {sharing?.members.map((member) => (
              <SettingsGroup key={member.userId} label={member.name}>
                <SettingsSwitch
                  label={t("Allow approvals")}
                  accessibilityLabel={t("Allow approvals for {name}", { name: member.name })}
                  value={member.canApprove}
                  disabled={busy}
                  onChange={(canApprove) =>
                    void change(() =>
                      rpc("bots/sharing/grant", { botId, userId: member.userId, canApprove }),
                    )
                  }
                />
                <SettingsRow
                  title={t("Remove")}
                  accessibilityRole="button"
                  accessibilityLabel={t("Remove {name}", { name: member.name })}
                  destructive
                  disabled={busy}
                  onPress={() =>
                    void change(() => rpc("bots/sharing/revoke", { botId, userId: member.userId }))
                  }
                />
                <SettingsRow
                  title={t("Transfer ownership")}
                  accessibilityRole="button"
                  accessibilityLabel={t("Transfer ownership to {name}", { name: member.name })}
                  disabled={busy}
                  onPress={() =>
                    Alert.alert(
                      t("Transfer ownership to {name}?", { name: member.name }),
                      t(
                        "Bot connections and credentials are removed; routines are paused. Replies use the new owner’s model connection.",
                      ),
                      [
                        { text: t("Cancel"), style: "cancel" },
                        {
                          text: t("Transfer"),
                          style: "destructive",
                          onPress: () =>
                            void change(
                              () => rpc("bots/sharing/transfer", { botId, userId: member.userId }),
                              true,
                            ),
                        },
                      ],
                    )
                  }
                />
              </SettingsGroup>
            ))}
          </>
        ) : null}
        {error ? (
          <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
            {error}
          </Text>
        ) : null}
      </ScrollView>
    </>
  );
}
