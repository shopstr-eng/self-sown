import { useCallback, useEffect, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";

import {
  ActionButton,
  EmptyState,
  ScreenScrollView,
  ScreenTitle,
  SellerCard,
  SellerField,
  StatusPill,
} from "@/components/seller-ui";
import LoadingScreen from "@/components/loading-screen";
import {
  createEmailFlow,
  deleteEmailFlow,
  deleteFlowStep,
  FLOW_TYPE_LABELS,
  FLOW_TYPES,
  formatDelayHours,
  getFlowClickStats,
  listEmailFlows,
  listFlowContacts,
  listFlowSteps,
  saveFlowStep,
  sendFlowTestEmail,
  sendFlowToContacts,
  toggleEmailFlow,
  updateEmailFlowSettings,
  type EmailFlow,
  type FlowContact,
  type FlowStep,
  type FlowType,
} from "@/lib/email-flows";
import { getMembershipStatus, isMembershipEntitled } from "@/lib/assistant";
import { getErrorMessage } from "@/lib/error-utils";
import { useSessionStore } from "@/stores/session-store";
import { sellerFonts, sellerThemeTokens } from "@/theme/tokens";

type EditorState = {
  flow: EmailFlow;
  steps: FlowStep[];
  fromName: string;
  replyTo: string;
};

export default function EmailFlowsScreen() {
  const session = useSessionStore((state) => state.session);

  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [entitled, setEntitled] = useState(false);
  const [flows, setFlows] = useState<EmailFlow[]>([]);
  const [clickStats, setClickStats] = useState<
    Record<number, { total: number; lastClicked: string | null }>
  >({});
  const [notice, setNotice] = useState("");
  const [formError, setFormError] = useState("");

  const [showCreate, setShowCreate] = useState(false);
  const [newFlowName, setNewFlowName] = useState("");
  const [newFlowType, setNewFlowType] = useState<FlowType>("post_purchase");
  const [creating, setCreating] = useState(false);

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorSaving, setEditorSaving] = useState(false);
  const [testEmail, setTestEmail] = useState("");
  const [sendingTest, setSendingTest] = useState(false);

  const [contactFlow, setContactFlow] = useState<EmailFlow | null>(null);
  const [contacts, setContacts] = useState<FlowContact[]>([]);
  const [selectedEmails, setSelectedEmails] = useState<Set<string>>(new Set());
  const [contactsLoading, setContactsLoading] = useState(false);
  const [sendingContacts, setSendingContacts] = useState(false);

  const refresh = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setLoadError("");
    try {
      const membership = await getMembershipStatus(session.pubkey);
      const isEntitled = isMembershipEntitled(membership.status);
      setEntitled(isEntitled);
      const loadedFlows = await listEmailFlows(session);
      setFlows(loadedFlows);
      if (isEntitled) {
        try {
          setClickStats(await getFlowClickStats(session));
        } catch {
          setClickStats({});
        }
      } else {
        setClickStats({});
      }
    } catch (caughtError) {
      setLoadError(
        getErrorMessage(caughtError, "Email flows could not be loaded.")
      );
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!session) return null;

  const handleCreate = async () => {
    if (!newFlowName.trim()) {
      setFormError("Enter a name for the flow.");
      return;
    }
    setCreating(true);
    setFormError("");
    setNotice("");
    try {
      const flow = await createEmailFlow(session, newFlowName, newFlowType);
      setNotice(`"${flow.name}" created with default email templates.`);
      setNewFlowName("");
      setShowCreate(false);
      await refresh();
    } catch (caughtError) {
      setFormError(
        getErrorMessage(caughtError, "The flow could not be created.")
      );
    } finally {
      setCreating(false);
    }
  };

  const handleToggle = async (flow: EmailFlow) => {
    setFormError("");
    setNotice("");
    try {
      const updated = await toggleEmailFlow(session, flow.id);
      setNotice(
        `"${flow.name}" is now ${
          updated.status === "active" ? "active" : "paused"
        }.`
      );
      await refresh();
    } catch (caughtError) {
      setFormError(
        getErrorMessage(caughtError, "The flow status could not be changed.")
      );
    }
  };

  const handleDelete = (flow: EmailFlow) => {
    Alert.alert(
      "Delete email flow",
      `Delete "${flow.name}" and all its steps? This can't be undone.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void (async () => {
              try {
                await deleteEmailFlow(session, flow.id);
                if (editor?.flow.id === flow.id) setEditor(null);
                setNotice(`"${flow.name}" deleted.`);
                await refresh();
              } catch (caughtError) {
                Alert.alert(
                  "Delete failed",
                  getErrorMessage(caughtError, "The flow could not be deleted.")
                );
              }
            })();
          },
        },
      ]
    );
  };

  const openEditor = async (flow: EmailFlow) => {
    setFormError("");
    setNotice("");
    try {
      const steps = await listFlowSteps(session, flow.id);
      setEditor({
        flow,
        steps,
        fromName: flow.from_name ?? "",
        replyTo: flow.reply_to ?? "",
      });
      setTestEmail("");
    } catch (caughtError) {
      setFormError(
        getErrorMessage(caughtError, "Flow steps could not be loaded.")
      );
    }
  };

  const updateStep = (
    index: number,
    field: keyof FlowStep,
    value: string | number
  ) => {
    setEditor((current) => {
      if (!current) return current;
      const steps = current.steps.map((step, stepIndex) =>
        stepIndex === index ? { ...step, [field]: value } : step
      );
      return { ...current, steps };
    });
  };

  const addStep = () => {
    setEditor((current) => {
      if (!current) return current;
      const maxOrder = current.steps.reduce(
        (max, step) => Math.max(max, step.step_order),
        0
      );
      const lastDelay =
        current.steps.length > 0
          ? (current.steps[current.steps.length - 1]?.delay_hours ?? 0)
          : 0;
      return {
        ...current,
        steps: [
          ...current.steps,
          {
            step_order: maxOrder + 1,
            subject: "",
            body_html: "",
            delay_hours: lastDelay + 24,
          },
        ],
      };
    });
  };

  const removeStep = (step: FlowStep, index: number) => {
    if (!editor) return;
    if (typeof step.id !== "number") {
      setEditor((current) =>
        current
          ? {
              ...current,
              steps: current.steps.filter(
                (_, stepIndex) => stepIndex !== index
              ),
            }
          : current
      );
      return;
    }
    Alert.alert("Delete step", "Remove this email from the flow?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: () => {
          void (async () => {
            try {
              await deleteFlowStep(session, editor.flow.id, step.id!);
              await openEditor(editor.flow);
            } catch (caughtError) {
              Alert.alert(
                "Delete failed",
                getErrorMessage(caughtError, "The step could not be deleted.")
              );
            }
          })();
        },
      },
    ]);
  };

  const handleSaveEditor = async () => {
    if (!editor) return;
    const incomplete = editor.steps.find(
      (step) => !step.subject.trim() || !step.body_html.trim()
    );
    if (incomplete) {
      setFormError("Every step needs a subject and a body before saving.");
      return;
    }
    setEditorSaving(true);
    setFormError("");
    setNotice("");
    try {
      await updateEmailFlowSettings(session, editor.flow.id, {
        fromName: editor.fromName,
        replyTo: editor.replyTo,
      });
      for (const step of editor.steps) {
        await saveFlowStep(session, editor.flow.id, step);
      }
      setNotice("Flow saved.");
      await refresh();
      await openEditor(editor.flow);
    } catch (caughtError) {
      setFormError(
        getErrorMessage(caughtError, "The flow could not be saved.")
      );
    } finally {
      setEditorSaving(false);
    }
  };

  const handleSendTest = async (step: FlowStep) => {
    if (!editor) return;
    const target = testEmail.trim();
    if (!target) {
      setFormError("Enter an email address to send the test to.");
      return;
    }
    if (!step.subject.trim() || !step.body_html.trim()) {
      setFormError("Add a subject and body before sending a test.");
      return;
    }
    setSendingTest(true);
    setFormError("");
    setNotice("");
    try {
      await sendFlowTestEmail(session, editor.flow.id, {
        targetEmail: target,
        subject: step.subject,
        bodyHtml: step.body_html,
      });
      setNotice(`Test email sent to ${target}.`);
    } catch (caughtError) {
      setFormError(
        getErrorMessage(caughtError, "The test email could not be sent.")
      );
    } finally {
      setSendingTest(false);
    }
  };

  const openContactPicker = async (flow: EmailFlow) => {
    setFormError("");
    setNotice("");
    if (flow.status !== "active") {
      setFormError("Activate this flow before sending it to your contacts.");
      return;
    }
    setContactFlow(flow);
    setContacts([]);
    setSelectedEmails(new Set());
    setContactsLoading(true);
    try {
      const loaded = await listFlowContacts(session, flow.id);
      setContacts(loaded);
      setSelectedEmails(
        new Set(
          loaded
            .filter((contact) => !contact.alreadyReceived)
            .map((contact) => contact.email.toLowerCase())
        )
      );
    } catch (caughtError) {
      setFormError(
        getErrorMessage(caughtError, "Contacts could not be loaded.")
      );
      setContactFlow(null);
    } finally {
      setContactsLoading(false);
    }
  };

  const handleSendToContacts = async () => {
    if (!contactFlow) return;
    if (selectedEmails.size === 0) {
      setFormError("Select at least one contact to send to.");
      return;
    }
    setSendingContacts(true);
    setFormError("");
    try {
      const emails = contacts
        .filter((contact) => selectedEmails.has(contact.email.toLowerCase()))
        .map((contact) => contact.email);
      const result = await sendFlowToContacts(session, contactFlow.id, emails);
      setNotice(
        result.enrolled === 0
          ? "Those contacts have already received this flow."
          : `Sending "${contactFlow.name}" to ${result.enrolled} contact${
              result.enrolled === 1 ? "" : "s"
            }${
              result.skipped
                ? ` (skipped ${result.skipped} who already received it)`
                : ""
            }. Emails go out within a few minutes.`
      );
      setContactFlow(null);
    } catch (caughtError) {
      setFormError(getErrorMessage(caughtError, "The flow could not be sent."));
    } finally {
      setSendingContacts(false);
    }
  };

  if (loading && flows.length === 0) {
    return <LoadingScreen message="Loading email flows..." />;
  }

  if (loadError && flows.length === 0) {
    return (
      <ScreenScrollView>
        <SellerCard title="Email flows unavailable">
          <Text style={styles.errorText}>{loadError}</Text>
          <ActionButton
            label="Retry"
            onPress={() => void refresh()}
            variant="secondary"
          />
        </SellerCard>
      </ScreenScrollView>
    );
  }

  if (!entitled) {
    return (
      <ScreenScrollView>
        <ScreenTitle
          eyebrow="Marketing"
          title="Email flows"
          description="Automated email series for your customers — welcome sequences, abandoned-cart reminders, post-purchase follow-ups, and win-back campaigns."
        />
        <SellerCard title="Email flows are a Herd feature">
          <Text style={styles.helperText}>
            Upgrade to Herd to create automated email flows for your customers.
          </Text>
        </SellerCard>
      </ScreenScrollView>
    );
  }

  if (contactFlow) {
    return (
      <ScreenScrollView>
        <ScreenTitle
          eyebrow="Email flows"
          title={`Send "${contactFlow.name}"`}
          description="Choose which contacts receive this flow. Contacts who already received it can't be selected again."
        />
        <SellerCard title="Contacts">
          {contactsLoading ? (
            <Text style={styles.helperText}>Loading contacts...</Text>
          ) : contacts.length === 0 ? (
            <EmptyState
              title="No contacts yet"
              description="Contacts come from your storefront popup and subscription captures."
            />
          ) : (
            contacts.map((contact) => {
              const key = contact.email.toLowerCase();
              const selected = selectedEmails.has(key);
              return (
                <Pressable
                  key={key}
                  accessibilityRole="button"
                  accessibilityState={{
                    selected,
                    disabled: contact.alreadyReceived,
                  }}
                  disabled={contact.alreadyReceived}
                  onPress={() =>
                    setSelectedEmails((current) => {
                      const next = new Set(current);
                      if (next.has(key)) next.delete(key);
                      else next.add(key);
                      return next;
                    })
                  }
                  style={[
                    styles.contactRow,
                    contact.alreadyReceived && styles.contactRowDisabled,
                  ]}
                >
                  <View style={styles.contactTextWrap}>
                    <Text style={styles.contactEmail}>{contact.email}</Text>
                    <Text style={styles.contactMeta}>
                      {contact.source === "subscription"
                        ? "Subscriber"
                        : "Popup capture"}
                      {contact.alreadyReceived ? " · already received" : ""}
                    </Text>
                  </View>
                  <Text style={styles.contactToggle}>
                    {contact.alreadyReceived ? "—" : selected ? "✓" : ""}
                  </Text>
                </Pressable>
              );
            })
          )}
          {formError ? <Text style={styles.errorText}>{formError}</Text> : null}
          <ActionButton
            label={`Send to ${selectedEmails.size} contact${
              selectedEmails.size === 1 ? "" : "s"
            }`}
            onPress={() => void handleSendToContacts()}
            loading={sendingContacts}
            disabled={selectedEmails.size === 0}
          />
          <ActionButton
            label="Back to flows"
            onPress={() => setContactFlow(null)}
            variant="secondary"
          />
        </SellerCard>
      </ScreenScrollView>
    );
  }

  if (editor) {
    return (
      <ScreenScrollView>
        <ScreenTitle
          eyebrow="Email flows"
          title={editor.flow.name}
          description={`${FLOW_TYPE_LABELS[editor.flow.flow_type as FlowType] ?? editor.flow.flow_type} · ${editor.flow.status}`}
        />
        <SellerCard title="Sender settings">
          <SellerField
            label="From name (optional)"
            value={editor.fromName}
            onChangeText={(value) =>
              setEditor((current) =>
                current ? { ...current, fromName: value } : current
              )
            }
            placeholder="Your shop name"
          />
          <SellerField
            label="Reply-to email (optional)"
            value={editor.replyTo}
            onChangeText={(value) =>
              setEditor((current) =>
                current ? { ...current, replyTo: value } : current
              )
            }
            placeholder="seller@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
          />
        </SellerCard>

        <SellerCard
          title="Steps"
          description="Each step is one email in the series, sent after the delay."
        >
          {editor.steps.map((step, index) => (
            <View key={step.id ?? `new-${index}`} style={styles.stepCard}>
              <Text style={styles.stepTitle}>
                Step {index + 1} · {formatDelayHours(step.delay_hours)}
              </Text>
              <SellerField
                label="Subject"
                value={step.subject}
                onChangeText={(value) => updateStep(index, "subject", value)}
                placeholder="Thanks for your order!"
              />
              <SellerField
                label="Body (HTML allowed)"
                value={step.body_html}
                onChangeText={(value) => updateStep(index, "body_html", value)}
                placeholder="Hi {{buyer_name}}, ..."
                multiline
              />
              <SellerField
                label="Delay (hours)"
                value={String(step.delay_hours)}
                onChangeText={(value) =>
                  updateStep(index, "delay_hours", parseInt(value, 10) || 0)
                }
                keyboardType="number-pad"
              />
              <ActionButton
                label="Delete step"
                onPress={() => removeStep(step, index)}
                variant="secondary"
              />
            </View>
          ))}
          <ActionButton
            label="Add step"
            onPress={addStep}
            variant="secondary"
          />
        </SellerCard>

        <SellerCard
          title="Send a test"
          description="Sends the last-touched step render to an address you choose."
        >
          <SellerField
            label="Test recipient"
            value={testEmail}
            onChangeText={setTestEmail}
            placeholder="you@example.com"
            keyboardType="email-address"
            autoCapitalize="none"
          />
          <ActionButton
            label="Send test of last step"
            onPress={() => {
              const last = editor.steps[editor.steps.length - 1];
              if (last) void handleSendTest(last);
            }}
            loading={sendingTest}
            variant="secondary"
            disabled={editor.steps.length === 0}
          />
        </SellerCard>

        {formError ? <Text style={styles.errorText}>{formError}</Text> : null}
        {notice ? <Text style={styles.successText}>{notice}</Text> : null}
        <ActionButton
          label="Save flow"
          onPress={() => void handleSaveEditor()}
          loading={editorSaving}
        />
        <ActionButton
          label="Back to flows"
          onPress={() => setEditor(null)}
          variant="secondary"
        />
      </ScreenScrollView>
    );
  }

  return (
    <ScreenScrollView>
      <ScreenTitle
        eyebrow="Marketing"
        title="Email flows"
        description="Automated email series for your customers. Create a flow, tune its steps, and send it to your contacts."
      />

      {notice ? <Text style={styles.successText}>{notice}</Text> : null}
      {formError ? <Text style={styles.errorText}>{formError}</Text> : null}

      <SellerCard title="New flow">
        {showCreate ? (
          <>
            <SellerField
              label="Flow name"
              value={newFlowName}
              onChangeText={setNewFlowName}
              placeholder="Welcome new buyers"
            />
            <View style={styles.typeOptions}>
              {FLOW_TYPES.map((type) => {
                const selected = newFlowType === type;
                return (
                  <Pressable
                    key={type}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    onPress={() => setNewFlowType(type)}
                    style={[
                      styles.typeOption,
                      selected && styles.typeOptionSelected,
                    ]}
                  >
                    <Text
                      style={[
                        styles.typeOptionLabel,
                        selected && styles.typeOptionLabelSelected,
                      ]}
                    >
                      {FLOW_TYPE_LABELS[type]}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
            <ActionButton
              label="Create flow"
              onPress={() => void handleCreate()}
              loading={creating}
              disabled={!newFlowName.trim()}
            />
            <ActionButton
              label="Cancel"
              onPress={() => setShowCreate(false)}
              variant="secondary"
            />
          </>
        ) : (
          <ActionButton
            label="Create a flow"
            onPress={() => setShowCreate(true)}
          />
        )}
      </SellerCard>

      <SellerCard title="Your flows" description={`${flows.length} total`}>
        {flows.length === 0 ? (
          <EmptyState
            title="No flows yet"
            description="Create your first flow above and it will appear here."
          />
        ) : (
          flows.map((flow) => {
            const stats = clickStats[flow.id];
            return (
              <View key={flow.id} style={styles.flowRow}>
                <View style={styles.flowHeader}>
                  <Text style={styles.flowName}>{flow.name}</Text>
                  <StatusPill
                    tone={flow.status === "active" ? "success" : "neutral"}
                    label={flow.status === "active" ? "Active" : "Paused"}
                  />
                </View>
                <Text style={styles.flowMeta}>
                  {FLOW_TYPE_LABELS[flow.flow_type as FlowType] ??
                    flow.flow_type}
                </Text>
                {stats ? (
                  <Text style={styles.flowMeta}>
                    Link clicks: {stats.total}
                    {stats.lastClicked
                      ? ` · last ${new Date(stats.lastClicked).toLocaleDateString()}`
                      : ""}
                  </Text>
                ) : null}
                <View style={styles.flowActions}>
                  <ActionButton
                    label="Edit"
                    onPress={() => void openEditor(flow)}
                    variant="secondary"
                  />
                  <ActionButton
                    label={flow.status === "active" ? "Pause" : "Activate"}
                    onPress={() => void handleToggle(flow)}
                    variant="secondary"
                  />
                  <ActionButton
                    label="Send to contacts"
                    onPress={() => void openContactPicker(flow)}
                    variant="secondary"
                  />
                  <ActionButton
                    label="Delete"
                    onPress={() => handleDelete(flow)}
                    variant="secondary"
                  />
                </View>
              </View>
            );
          })
        )}
      </SellerCard>
    </ScreenScrollView>
  );
}

const styles = StyleSheet.create({
  helperText: {
    color: sellerThemeTokens.mutedText,
    fontSize: 14,
    fontFamily: sellerFonts.regular,
    lineHeight: 21,
  },
  errorText: {
    color: sellerThemeTokens.danger,
    fontSize: 14,
    fontFamily: sellerFonts.regular,
    lineHeight: 20,
  },
  successText: {
    color: sellerThemeTokens.success,
    fontSize: 14,
    fontFamily: sellerFonts.regular,
    lineHeight: 20,
  },
  typeOptions: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  typeOption: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    backgroundColor: sellerThemeTokens.surface,
  },
  typeOptionSelected: {
    backgroundColor: sellerThemeTokens.primary,
  },
  typeOptionLabel: {
    color: sellerThemeTokens.text,
    fontSize: 13,
    fontFamily: sellerFonts.bold,
  },
  typeOptionLabelSelected: {
    color: sellerThemeTokens.surface,
  },
  flowRow: {
    gap: 8,
    padding: 14,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    backgroundColor: sellerThemeTokens.surface,
  },
  flowHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  flowName: {
    color: sellerThemeTokens.text,
    fontSize: 17,
    fontFamily: sellerFonts.bold,
    flexShrink: 1,
  },
  flowMeta: {
    color: sellerThemeTokens.mutedText,
    fontSize: 13,
    fontFamily: sellerFonts.regular,
  },
  flowActions: {
    gap: 8,
  },
  stepCard: {
    gap: 10,
    padding: 14,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    backgroundColor: sellerThemeTokens.surface,
  },
  stepTitle: {
    color: sellerThemeTokens.text,
    fontSize: 15,
    fontFamily: sellerFonts.bold,
  },
  contactRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    padding: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: sellerThemeTokens.black,
    backgroundColor: sellerThemeTokens.surface,
  },
  contactRowDisabled: {
    opacity: 0.5,
  },
  contactTextWrap: {
    flex: 1,
    gap: 2,
  },
  contactEmail: {
    color: sellerThemeTokens.text,
    fontSize: 15,
    fontFamily: sellerFonts.bold,
  },
  contactMeta: {
    color: sellerThemeTokens.mutedText,
    fontSize: 13,
    fontFamily: sellerFonts.regular,
  },
  contactToggle: {
    color: sellerThemeTokens.primary,
    fontSize: 18,
    fontFamily: sellerFonts.bold,
  },
});
